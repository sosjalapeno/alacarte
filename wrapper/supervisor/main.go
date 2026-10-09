package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var codeRegex = regexp.MustCompile(`^\d{6}$`)

const (
	stopGrace       = 3 * time.Second
	crashRestart    = 3 * time.Second
	minCleanBackoff = 5 * time.Second
	maxCleanBackoff = 60 * time.Second
	stableUptime    = 30 * time.Second
	// Apple ends the wrapper's playback lease when another device on the
	// account starts streaming, and the wrapper exits. Restarting takes the
	// lease back, so wait long enough not to fight that device.
	minLeaseBackoff   = time.Minute
	maxLeaseBackoff   = 15 * time.Minute
	leaseStableUptime = 10 * time.Minute
	maxBodyBytes      = 64 << 10
	loginSuccessMsg   = "account info cached successfully"
)

type Mode string

const (
	ModeIdle      Mode = "idle"
	ModeNormal    Mode = "normal"
	ModeLoggingIn Mode = "logging_in"
)

type proc struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type Supervisor struct {
	mu             sync.Mutex
	wrapperBin     string
	wrapperDataDir string
	normalArgs     []string
	mode           Mode
	normal         *proc
	loginCancel    context.CancelFunc
	stopping       bool
	cleanExits     int
	leaseLosses    int
	restartReason  string
	restartAt      time.Time
	wake           chan struct{}
	// Required in the X-Supervisor-Token header on the control endpoints;
	// empty disables the check.
	controlToken     string
	credWatchRunning atomic.Bool
}

func NewSupervisor(wrapperBin, wrapperDataDir string, normalArgs []string) *Supervisor {
	return &Supervisor{
		wrapperBin:     wrapperBin,
		wrapperDataDir: wrapperDataDir,
		normalArgs:     normalArgs,
		mode:           ModeIdle,
		wake:           make(chan struct{}, 1),
	}
}

func (s *Supervisor) hasCredentials() bool {
	candidates := []string{
		filepath.Join(s.wrapperDataDir, "data", "com.apple.android.music", "files", "MUSIC_TOKEN"),
		filepath.Join(s.wrapperDataDir, "MUSIC_TOKEN"),
	}
	for _, p := range candidates {
		if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
			return true
		}
	}
	return false
}

func (s *Supervisor) scheduleCredentialWatch() {
	if !s.credWatchRunning.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer s.credWatchRunning.Store(false)
		for {
			select {
			case <-time.After(30 * time.Second):
			case <-s.wake:
			}
			s.mu.Lock()
			stopping := s.stopping
			idle := s.mode == ModeIdle && s.restartReason == "unauthenticated"
			s.mu.Unlock()
			if stopping || !idle {
				return
			}
			if s.hasCredentials() {
				log.Printf("[supervisor] credentials detected in %s; starting normal wrapper", s.wrapperDataDir)
				s.StartNormal()
				return
			}
		}
	}()
}

func (s *Supervisor) get2faFilePath() string {
	return filepath.Join(s.wrapperDataDir, "data", "com.apple.android.music", "files", "2fa.txt")
}

func (s *Supervisor) clear2faFiles() {
	target := s.get2faFilePath()
	dir := filepath.Dir(target)
	candidates := []string{
		target,
		filepath.Join(dir, ".2fa.txt.tmp"),
		filepath.Join(s.wrapperDataDir, "2fa.txt"),
		filepath.Join(s.wrapperDataDir, ".2fa.txt.tmp"),
	}
	for _, p := range candidates {
		_ = os.Remove(p)
	}
}

func (s *Supervisor) write2faCode(code string) error {
	code = strings.TrimSpace(code)
	if !codeRegex.MatchString(code) {
		return errors.New("2FA code must be exactly 6 digits")
	}
	target := s.get2faFilePath()
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create 2fa directory: %w", err)
	}

	tmpFile := filepath.Join(dir, fmt.Sprintf(".2fa.txt.%d.%d.tmp", os.Getpid(), time.Now().UnixNano()))
	if err := os.WriteFile(tmpFile, []byte(code), 0600); err != nil {
		return fmt.Errorf("failed to write temporary 2fa file: %w", err)
	}
	if err := os.Rename(tmpFile, target); err != nil {
		_ = os.Remove(tmpFile)
		return fmt.Errorf("failed to commit 2fa file: %w", err)
	}
	return nil
}

// run starts the wrapper and feeds each output line to onLine. Cancelling ctx
// sends SIGTERM, escalating to SIGKILL after stopGrace. The returned channel
// yields the exit error once the process is gone and its output is drained.
//
// The wrapper forks a child that outlives it and keeps serving the wrapper
// ports, so each run gets its own process group and the whole group is
// signalled and reaped.
func (s *Supervisor) run(ctx context.Context, args []string, onLine func(string)) (<-chan error, error) {
	cmd := exec.CommandContext(ctx, s.wrapperBin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = stopGrace
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	scanned := make(chan struct{})
	go func() {
		defer close(scanned)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			onLine(sc.Text())
		}
		_, _ = io.Copy(io.Discard, pr)
	}()

	exited := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		killGroup(cmd.Process.Pid)
		_ = pw.Close()
		<-scanned
		exited <- err
	}()
	return exited, nil
}

// killGroup kills what is left of a process group and reaps members that were
// reparented to the supervisor, which runs as PID 1 in the container.
func killGroup(pgid int) {
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
	for {
		var ws syscall.WaitStatus
		_, err := syscall.Wait4(-pgid, &ws, 0, nil)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return
		}
	}
}

// restartDelay backs off consecutive clean exits (e.g. no credentials yet)
// while still restarting, so the wrapper recovers once credentials exist.
// A lost playback lease backs off much longer; see minLeaseBackoff.
func (s *Supervisor) restartDelay(exitErr error, uptime time.Duration, leaseLost bool) time.Duration {
	if leaseLost {
		if uptime > leaseStableUptime {
			s.leaseLosses = 0
		}
		s.leaseLosses++
		return backoff(minLeaseBackoff, maxLeaseBackoff, s.leaseLosses)
	}
	s.leaseLosses = 0
	if exitErr != nil {
		s.cleanExits = 0
		return crashRestart
	}
	if uptime > stableUptime {
		s.cleanExits = 0
	}
	s.cleanExits++
	return backoff(minCleanBackoff, maxCleanBackoff, s.cleanExits)
}

func backoff(base, limit time.Duration, attempt int) time.Duration {
	d := base
	for i := 1; i < attempt && d < limit; i++ {
		d *= 2
	}
	return min(d, limit)
}

func isLeaseLossLine(line string) bool {
	return strings.Contains(line, "end lease code") ||
		strings.Contains(line, "More than one device is trying to play")
}

func (s *Supervisor) StartNormal() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping || s.mode != ModeIdle {
		return
	}

	if !s.hasCredentials() {
		s.mode = ModeIdle
		s.restartReason = "unauthenticated"
		s.restartAt = time.Time{}
		log.Printf("[supervisor] No cached Apple Music credentials found in %s; paused in idle mode waiting for sign-in", s.wrapperDataDir)
		s.scheduleCredentialWatch()
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	var leaseLost atomic.Bool
	exited, err := s.run(ctx, s.normalArgs, func(line string) {
		log.Printf("[wrapper] %s", line)
		if isLeaseLossLine(line) {
			leaseLost.Store(true)
		}
	})
	if err != nil {
		cancel()
		log.Printf("[supervisor] failed to start wrapper: %v", err)
		return
	}
	p := &proc{cancel: cancel, done: make(chan struct{})}
	s.normal = p
	s.mode = ModeNormal
	s.restartReason = ""
	s.restartAt = time.Time{}
	started := time.Now()
	log.Printf("[supervisor] normal wrapper started")

	go func() {
		err := <-exited
		cancel()
		s.mu.Lock()
		// stopNormal detaches p before cancelling, so a mismatch means the
		// exit was requested and must not trigger a restart.
		unexpected := s.normal == p && !s.stopping
		var delay time.Duration
		if unexpected {
			s.normal = nil
			s.mode = ModeIdle
			if !s.hasCredentials() {
				s.restartReason = "unauthenticated"
				s.restartAt = time.Time{}
				s.cleanExits = 0
				log.Printf("[supervisor] wrapper exited and credentials are missing; pausing in idle mode")
				s.mu.Unlock()
				s.scheduleCredentialWatch()
				close(p.done)
				return
			}
			delay = s.restartDelay(err, time.Since(started), leaseLost.Load())
			s.restartReason = exitReason(err, leaseLost.Load())
			s.restartAt = time.Now().Add(delay)
			select { // drop a wake request that arrived while it was running
			case <-s.wake:
			default:
			}
		}
		s.mu.Unlock()
		close(p.done)
		if !unexpected {
			return
		}
		log.Printf("[supervisor] wrapper exited (%v, %s), restarting in %s", exitDesc(err), s.reasonSnapshot(), delay)
		select {
		case <-time.After(delay):
		case <-s.wake:
			log.Printf("[supervisor] woken early")
		}
		s.StartNormal()
	}()
}

// stopNormal stops the normal wrapper without scheduling a restart and waits
// for it to exit. Callers must not hold s.mu.
func (s *Supervisor) stopNormal() {
	s.mu.Lock()
	p := s.normal
	s.normal = nil
	s.mu.Unlock()
	if p == nil {
		return
	}
	p.cancel()
	<-p.done
}

func exitReason(err error, leaseLost bool) string {
	switch {
	case leaseLost:
		return "lease_lost"
	case err != nil:
		return "crashed"
	default:
		return "exited"
	}
}

func (s *Supervisor) reasonSnapshot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.restartReason
}

func exitDesc(err error) string {
	if err == nil {
		return "exit status 0"
	}
	return err.Error()
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type TwoFaRequest struct {
	Code string `json:"code"`
}

type HealthResponse struct {
	Ok            bool   `json:"ok"`
	Mode          string `json:"mode"`
	Running       bool   `json:"running"`
	Authenticated bool   `json:"authenticated"`
	// Set while waiting to restart the wrapper after it exited on its own,
	// or "unauthenticated" when waiting for Apple credentials.
	Reason      string `json:"reason,omitempty"`
	RestartInMs int64  `json:"restartInMs,omitempty"`
}

func (s *Supervisor) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	resp := HealthResponse{
		Ok:            true,
		Mode:          string(s.mode),
		Running:       s.normal != nil || s.mode == ModeLoggingIn,
		Authenticated: s.hasCredentials(),
	}
	if s.mode == ModeIdle {
		resp.Reason = s.restartReason
		if !s.restartAt.IsZero() {
			resp.RestartInMs = max(0, time.Until(s.restartAt).Milliseconds())
		}
	}
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleLogin runs a sign-in worker and streams its output. The worker lives
// exactly as long as the request: it is stopped on success, and a client
// disconnect cancels it.
func (s *Supervisor) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req LoginRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}
	if req.Email == "" || req.Password == "" {
		http.Error(w, "email and password are required", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	s.mu.Lock()
	if s.stopping || s.mode == ModeLoggingIn {
		s.mu.Unlock()
		http.Error(w, "A sign-in is already in progress", http.StatusConflict)
		return
	}
	s.mode = ModeLoggingIn
	s.loginCancel = cancel
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.mode = ModeIdle
		s.loginCancel = nil
		s.mu.Unlock()
		s.clear2faFiles()
		s.StartNormal()
	}()

	s.stopNormal()
	s.clear2faFiles()

	lines := make(chan string, 64)
	args := append([]string{"-L", req.Email + ":" + req.Password, "-F"}, s.normalArgs...)
	exited, err := s.run(ctx, args, func(line string) {
		select {
		case lines <- line:
		case <-ctx.Done():
		}
		if strings.Contains(strings.ToLower(line), loginSuccessMsg) {
			cancel()
		}
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to start login process: %v", err), http.StatusInternalServerError)
		return
	}
	log.Printf("[supervisor] sign-in worker started")

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	write := func(line string) {
		_, _ = fmt.Fprintf(w, "%s\n", line)
		if flusher != nil {
			flusher.Flush()
		}
	}
	if flusher != nil {
		flusher.Flush()
	}

	for {
		select {
		case line := <-lines:
			write(line)
		case err := <-exited:
			for {
				select {
				case line := <-lines:
					write(line)
				default:
					log.Printf("[supervisor] sign-in worker exited (%s)", exitDesc(err))
					return
				}
			}
		}
	}
}

func (s *Supervisor) handle2FA(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req TwoFaRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	loggingIn := s.mode == ModeLoggingIn
	s.mu.Unlock()
	if !loggingIn {
		http.Error(w, "No sign-in in progress", http.StatusConflict)
		return
	}

	if err := s.write2faCode(req.Code); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	log.Printf("[supervisor] 2FA code committed")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// handleWake starts the wrapper now instead of waiting out a restart
// backoff; the backend calls it before a download needs the wrapper.
func (s *Supervisor) handleWake(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
	s.StartNormal()
	s.handleHealth(w, r)
}

func (s *Supervisor) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/login", s.requireControlToken(s.handleLogin))
	mux.HandleFunc("/login/2fa", s.requireControlToken(s.handle2FA))
	mux.HandleFunc("/wake", s.requireControlToken(s.handleWake))
	return mux
}

func (s *Supervisor) Stop() {
	s.mu.Lock()
	s.stopping = true
	if s.loginCancel != nil {
		s.loginCancel()
	}
	s.mu.Unlock()
	s.stopNormal()
}

// requireControlToken keeps other containers on the Docker network from
// signing the wrapper in to another account or submitting 2FA codes.
// /health stays open: it only reports state.
func (s *Supervisor) requireControlToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.controlToken != "" {
			got := r.Header.Get("X-Supervisor-Token")
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.controlToken)) != 1 {
				http.Error(w, "missing or invalid supervisor token", http.StatusUnauthorized)
				return
			}
		}
		next(w, r)
	}
}

// loadControlToken reads the shared token file, creating it with a random
// token on first start. The web container reads the same file.
func loadControlToken(path string) (string, error) {
	if raw, err := os.ReadFile(path); err == nil {
		if token := strings.TrimSpace(string(raw)); token != "" {
			return token, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(token+"\n"), 0600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return token, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// All arguments are passed through to the wrapper; the supervisor itself is
// configured through the environment.
func main() {
	addr := envOr("SUPERVISOR_HOST", "0.0.0.0") + ":" + envOr("SUPERVISOR_PORT", "40020")
	normalArgs := os.Args[1:]
	if len(normalArgs) == 0 {
		normalArgs = []string{"-H", "0.0.0.0"}
	}

	sup := NewSupervisor(
		envOr("WRAPPER_BIN", "/app/wrapper"),
		envOr("WRAPPER_DATA_DIR", "/app/rootfs/data"),
		normalArgs,
	)
	if tokenFile := os.Getenv("SUPERVISOR_TOKEN_FILE"); tokenFile != "" {
		token, err := loadControlToken(tokenFile)
		if err != nil {
			log.Fatalf("[supervisor] cannot load the control token from %s: %v", tokenFile, err)
		}
		sup.controlToken = token
	} else {
		log.Printf("[supervisor] SUPERVISOR_TOKEN_FILE is not set; the control API accepts any caller")
	}
	server := &http.Server{Addr: addr, Handler: sup.routes()}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Printf("[supervisor] shutting down...")
		sup.Stop()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()

	sup.StartNormal()

	log.Printf("[supervisor] HTTP control server listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[supervisor] server error: %v", err)
	}
}
