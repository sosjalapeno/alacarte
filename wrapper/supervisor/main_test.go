package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Fake wrapper: like the real one it forks a long-lived child that shares
// stdout, and keeps running after sign-in. The child's pid is recorded per mode.
const fakeWrapper = `#!/bin/sh
mode=normal
[ "$1" = "-L" ] && mode=login
sleep 30 &
echo $! > "$FAKE_PID_DIR/$mode.child"
if [ $mode = login ]; then
  printf '%s\n' "[+] logging in..."
  [ -n "$FAKE_LOGIN_OUT" ] && printf '%s\n' "$FAKE_LOGIN_OUT"
fi
exec sleep 30
`

func newTestSupervisor(t *testing.T, loginOut string) (*Supervisor, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "wrapper")
	if err := os.WriteFile(bin, []byte(fakeWrapper), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_LOGIN_OUT", loginOut)
	t.Setenv("FAKE_PID_DIR", dir)
	dataDir := filepath.Join(dir, "data")
	tokenFile := filepath.Join(dataDir, "data", "com.apple.android.music", "files", "MUSIC_TOKEN")
	_ = os.MkdirAll(filepath.Dir(tokenFile), 0755)
	_ = os.WriteFile(tokenFile, []byte("fake-token"), 0600)
	sup := NewSupervisor(bin, dataDir, []string{"-H", "0.0.0.0"})
	srv := httptest.NewServer(sup.routes())
	t.Cleanup(func() {
		sup.Stop()
		srv.Close()
	})
	return sup, srv
}

func health(t *testing.T, srv *httptest.Server) HealthResponse {
	t.Helper()
	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var h HealthResponse
	if err := json.NewDecoder(res.Body).Decode(&h); err != nil {
		t.Fatal(err)
	}
	return h
}

func waitForMode(t *testing.T, srv *httptest.Server, want Mode) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if health(t, srv).Mode == string(want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("mode never became %q (last %q)", want, health(t, srv).Mode)
}

// childPid returns the pid of the child the fake wrapper of the given run
// mode forked. The supervisor reports a mode as soon as it starts the
// process, which can be before the script has recorded the pid, so wait for
// it. Read it before the process is meant to go: a later run of the same
// mode overwrites the file with its own, live child.
func childPid(t *testing.T, sup *Supervisor, mode string) string {
	t.Helper()
	file := filepath.Join(filepath.Dir(sup.wrapperBin), mode+".child")
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(file)
		if pid := strings.TrimSpace(string(raw)); err == nil && pid != "" {
			return pid
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s wrapper never recorded its child: %v", mode, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// assertChildGone checks that the given forked child was killed along with
// its parent (a zombie counts as gone).
func assertChildGone(t *testing.T, mode, pid string) {
	t.Helper()
	stat := "/proc/" + pid + "/stat"
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		b, err := os.ReadFile(stat)
		if err != nil || strings.Contains(string(b), ") Z ") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s wrapper child survived its parent", mode)
}

func postLogin(ctx context.Context, srv *httptest.Server) (*http.Response, error) {
	body := `{"email":"user@example.com","password":"pw"}`
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/login", strings.NewReader(body))
	return http.DefaultClient.Do(req)
}

func Test2FAValidationAndWriting(t *testing.T) {
	sup := NewSupervisor("nonexistent-bin", t.TempDir(), nil)

	for _, code := range []string{"12345", "1234567", "abcdef", "12a456", ""} {
		if err := sup.write2faCode(code); err == nil {
			t.Errorf("expected error for code %q, got nil", code)
		}
	}

	if err := sup.write2faCode("654321"); err != nil {
		t.Fatalf("failed to write valid code: %v", err)
	}
	data, err := os.ReadFile(sup.get2faFilePath())
	if err != nil {
		t.Fatalf("failed to read 2fa file: %v", err)
	}
	if string(data) != "654321" {
		t.Errorf("expected file content '654321', got %q", string(data))
	}

	sup.clear2faFiles()
	if _, err := os.Stat(sup.get2faFilePath()); !os.IsNotExist(err) {
		t.Errorf("expected 2fa file to be removed, but stat returned: %v", err)
	}
}

func TestRestartDelay(t *testing.T) {
	sup := NewSupervisor("", "", nil)
	var got []time.Duration
	for i := 0; i < 6; i++ {
		got = append(got, sup.restartDelay(nil, time.Second, false))
	}
	want := []time.Duration{5, 10, 20, 40, 60, 60}
	for i := range want {
		if got[i] != want[i]*time.Second {
			t.Fatalf("clean exit delays = %v, want %v s", got, want)
		}
	}
	if d := sup.restartDelay(nil, time.Minute, false); d != 5*time.Second {
		t.Errorf("stable run should reset backoff, got %s", d)
	}
	if d := sup.restartDelay(errors.New("exit status 1"), time.Second, false); d != crashRestart {
		t.Errorf("crash delay = %s, want %s", d, crashRestart)
	}
}

func TestMethodAndPayloadValidation(t *testing.T) {
	_, srv := newTestSupervisor(t, "")

	res, _ := http.Get(srv.URL + "/login")
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET /login status = %d", res.StatusCode)
	}
	res, _ = http.Post(srv.URL+"/login", "application/json", bytes.NewBufferString(`{"email":""}`))
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("empty credentials status = %d", res.StatusCode)
	}
	res, _ = http.Post(srv.URL+"/login/2fa", "application/json", bytes.NewBufferString(`{"code":"123456"}`))
	if res.StatusCode != http.StatusConflict {
		t.Errorf("2FA without sign-in status = %d", res.StatusCode)
	}
}

func TestLoginStopsWorkerOnSuccessAndRestoresNormal(t *testing.T) {
	sup, srv := newTestSupervisor(t, "[.] account info cached successfully")
	sup.StartNormal()
	waitForMode(t, srv, ModeNormal)
	normalChild := childPid(t, sup, "normal")

	start := time.Now()
	res, err := postLogin(context.Background(), srv)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(out), "account info cached successfully") {
		t.Fatalf("stream missing success line: %q", out)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("worker was not stopped promptly after success (took %s)", time.Since(start))
	}
	assertChildGone(t, "normal", normalChild)
	assertChildGone(t, "login", childPid(t, sup, "login"))
	waitForMode(t, srv, ModeNormal)
}

func TestLoginCancelledByClientDisconnect(t *testing.T) {
	sup, srv := newTestSupervisor(t, "[!] Enter your 2FA code into rootfs/data/2fa.txt")
	sup.StartNormal()
	waitForMode(t, srv, ModeNormal)

	ctx, cancel := context.WithCancel(context.Background())
	res, err := postLogin(ctx, srv)
	if err != nil {
		t.Fatal(err)
	}
	waitForMode(t, srv, ModeLoggingIn)
	loginChild := childPid(t, sup, "login")

	if r, _ := postLogin(context.Background(), srv); r.StatusCode != http.StatusConflict {
		t.Errorf("concurrent login status = %d, want 409", r.StatusCode)
	}
	r, err := http.Post(srv.URL+"/login/2fa", "application/json", bytes.NewBufferString(`{"code":"123456"}`))
	if err != nil || r.StatusCode != http.StatusOK {
		t.Fatalf("2FA during sign-in failed: %v %v", err, r)
	}

	cancel()
	res.Body.Close()
	waitForMode(t, srv, ModeNormal)
	assertChildGone(t, "login", loginChild)
	if _, err := os.Stat(sup.get2faFilePath()); !os.IsNotExist(err) {
		t.Errorf("2fa file should be cleared after sign-in ends: %v", err)
	}
}

// #33: the shipped wrapper exits 1 when Apple ends its playback lease
// because another device on the account started playing, and requests the
// lease again on every start. Restarting every few seconds would keep taking
// the stream from that device.
const leaseLossWrapper = `#!/bin/sh
echo start >> "$FAKE_PID_DIR/starts"
echo "[+] account info cached successfully"
echo "[.] dialogHandler: {title: More than one device is trying to play music., message: With a Family plan, up to 5 other people can stream their music at once.}"
echo "[.] end lease code 1"
exit 1
`

func TestLeaseBackoff(t *testing.T) {
	sup := NewSupervisor("", "", nil)
	var got []time.Duration
	for i := 0; i < 6; i++ {
		got = append(got, sup.restartDelay(errors.New("exit status 1"), time.Second, true))
	}
	want := []time.Duration{1, 2, 4, 8, 15, 15}
	for i := range want {
		if got[i] != want[i]*time.Minute {
			t.Fatalf("lease loss delays = %v, want %v min", got, want)
		}
	}
	if d := sup.restartDelay(errors.New("exit status 1"), 11*time.Minute, true); d != time.Minute {
		t.Errorf("a long run should reset the lease backoff, got %s", d)
	}
	if d := sup.restartDelay(errors.New("exit status 1"), time.Second, false); d != crashRestart {
		t.Errorf("an ordinary crash should still restart after %s, got %s", crashRestart, d)
	}
}

func TestLeaseLossWaitsAndWakeRestarts(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "wrapper")
	if err := os.WriteFile(bin, []byte(leaseLossWrapper), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_PID_DIR", dir)
	dataDir := filepath.Join(dir, "data")
	tokenFile := filepath.Join(dataDir, "data", "com.apple.android.music", "files", "MUSIC_TOKEN")
	_ = os.MkdirAll(filepath.Dir(tokenFile), 0755)
	_ = os.WriteFile(tokenFile, []byte("fake-token"), 0600)
	sup := NewSupervisor(bin, dataDir, []string{"-H", "0.0.0.0"})
	srv := httptest.NewServer(sup.routes())
	t.Cleanup(func() {
		sup.Stop()
		srv.Close()
	})
	starts := func() int {
		raw, _ := os.ReadFile(filepath.Join(dir, "starts"))
		return strings.Count(string(raw), "start")
	}

	sup.StartNormal()
	time.Sleep(crashRestart*2 + time.Second)
	if n := starts(); n != 1 {
		t.Fatalf("wrapper restarted %d times within %s of losing the lease", n-1, crashRestart*2)
	}
	h := health(t, srv)
	if h.Mode != string(ModeIdle) || h.Reason != "lease_lost" || h.RestartInMs < 50_000 {
		t.Fatalf("health during lease backoff = %+v", h)
	}

	res, err := http.Post(srv.URL+"/wake", "application/json", nil)
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("wake failed: %v %v", err, res)
	}
	deadline := time.Now().Add(2 * time.Second)
	for starts() < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := starts(); n != 2 {
		t.Fatalf("wake should start the wrapper right away, starts = %d", n)
	}
}

func TestControlEndpointsNeedTheToken(t *testing.T) {
	sup, srv := newTestSupervisor(t, "")
	sup.controlToken = "s3cret"

	post := func(path, token string) int {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+path, strings.NewReader(`{"email":"a@b.c","password":"pw","code":"123456"}`))
		if token != "" {
			req.Header.Set("X-Supervisor-Token", token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for _, path := range []string{"/login", "/login/2fa", "/wake"} {
		if got := post(path, ""); got != http.StatusUnauthorized {
			t.Errorf("%s without token = %d", path, got)
		}
		if got := post(path, "wrong"); got != http.StatusUnauthorized {
			t.Errorf("%s with wrong token = %d", path, got)
		}
	}
	// The right token gets through to the handler (no sign-in running).
	if got := post("/login/2fa", "s3cret"); got != http.StatusConflict {
		t.Errorf("2FA with token = %d", got)
	}
	if got := post("/wake", "s3cret"); got != http.StatusOK {
		t.Errorf("wake with token = %d", got)
	}
	// Health stays open for the backend's reachability probe.
	if res, err := http.Get(srv.URL + "/health"); err != nil || res.StatusCode != http.StatusOK {
		t.Errorf("health without token failed: %v", err)
	}
}

func TestLoadControlTokenCreatesThenReuses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret", "token")
	first, err := loadControlToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 64 {
		t.Fatalf("token %q is not 32 random bytes", first)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("token file mode = %v", info.Mode().Perm())
	}
	second, err := loadControlToken(path)
	if err != nil || second != first {
		t.Fatalf("token changed on reload: %q -> %q (%v)", first, second, err)
	}
}

func TestUnauthenticatedIdleMode(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "wrapper")
	if err := os.WriteFile(bin, []byte(fakeWrapper), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_PID_DIR", dir)
	dataDir := filepath.Join(dir, "data")
	sup := NewSupervisor(bin, dataDir, []string{"-H", "0.0.0.0"})
	srv := httptest.NewServer(sup.routes())
	t.Cleanup(func() {
		sup.Stop()
		srv.Close()
	})

	// Start without credentials
	sup.StartNormal()

	// Should be idle and unauthenticated
	h := health(t, srv)
	if h.Mode != "idle" || h.Running {
		t.Fatalf("expected idle/not running, got mode=%q running=%v", h.Mode, h.Running)
	}
	if h.Reason != "unauthenticated" {
		t.Fatalf("expected reason unauthenticated, got %q", h.Reason)
	}
	if h.Authenticated {
		t.Fatalf("expected Authenticated=false, got true")
	}

	// Fake wrapper child must NOT have been started
	if _, err := os.Stat(filepath.Join(dir, "normal.child")); !os.IsNotExist(err) {
		t.Fatalf("wrapper child was started despite missing credentials")
	}

	// Simulate credentials being created on disk (e.g. volume restored or sign-in)
	tokenFile := filepath.Join(dataDir, "data", "com.apple.android.music", "files", "MUSIC_TOKEN")
	if err := os.MkdirAll(filepath.Dir(tokenFile), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenFile, []byte("valid-token"), 0600); err != nil {
		t.Fatal(err)
	}

	// Wake supervisor
	res, err := http.Post(srv.URL+"/wake", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	waitForMode(t, srv, ModeNormal)
	h = health(t, srv)
	if !h.Running || !h.Authenticated {
		t.Fatalf("expected running and authenticated after wake, got running=%v auth=%v", h.Running, h.Authenticated)
	}
}
