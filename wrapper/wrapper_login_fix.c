/*
 * Runtime compatibility fixes for the prebuilt Android wrapper worker.
 *
 * This object is linked against the bionic libc bundled in rootfs and loaded
 * by Android's linker after the outer glibc wrapper chroots into rootfs.
 */

typedef unsigned long size_type;
typedef long signed_size_type;

struct shared_ptr {
  void *obj;
  void *ctrl_blk;
};

union std_string {
  struct {
    unsigned char mark;
    char str[0];
  } short_mode;
  struct {
    size_type cap;
    size_type size;
    const char *data;
  } long_mode;
};

extern void *dlsym(void *handle, const char *symbol);
extern signed_size_type write(int fd, const void *buf, size_type count);

#define RTLD_NEXT ((void *)-1L)

/* Argument parsing happens once, before the worker starts its server threads. */
static char *saved_password;
static int login_split_active;

static int text_equal(const char *left, const char *right) {
  if (left == 0 || right == 0) return 0;
  while (*left != '\0' && *left == *right) {
    left++;
    right++;
  }
  return *left == *right;
}

static char *find_char(char *text, char wanted) {
  if (text == 0) return 0;
  while (*text != '\0') {
    if (*text == wanted) return text;
    text++;
  }
  return 0;
}

static size_type bounded_length(const char *text, size_type limit) {
  size_type length = 0;
  if (text == 0) return 0;
  while (length < limit && text[length] != '\0') length++;
  return length;
}

static void write_text(const char *text) {
  const size_type length = bounded_length(text, 1024);
  if (length != 0) (void)write(2, text, length);
}

static void write_number(int value) {
  char digits[24];
  unsigned int magnitude;
  int cursor = (int)sizeof(digits);

  if (value < 0) {
    write_text("-");
    magnitude = 0U - (unsigned int)value;
  } else {
    magnitude = (unsigned int)value;
  }

  do {
    digits[--cursor] = (char)('0' + (magnitude % 10U));
    magnitude /= 10U;
  } while (magnitude != 0U);
  (void)write(2, digits + cursor, (size_type)((int)sizeof(digits) - cursor));
}

static const char *std_string_data(union std_string *value) {
  if (value == 0) return 0;
  if ((value->short_mode.mark & 1U) == 0U) return value->short_mode.str;
  return value->long_mode.data;
}

char *strtok(char *text, const char *delimiters) {
  typedef char *(*strtok_fn)(char *, const char *);
  static strtok_fn real_strtok;

  if (real_strtok == 0) {
    real_strtok = (strtok_fn)dlsym(RTLD_NEXT, "strtok");
  }

  if (text_equal(delimiters, ":")) {
    if (text != 0 && find_char(text, '@') != 0) {
      char *separator = find_char(text, ':');
      if (separator != 0) {
        *separator = '\0';
        saved_password = separator + 1;
        login_split_active = 1;
        return text;
      }
    } else if (text == 0 && login_split_active) {
      char *password = saved_password;
      saved_password = 0;
      login_split_active = 0;
      return password != 0 && *password != '\0' ? password : 0;
    }
  }

  saved_password = 0;
  login_split_active = 0;
  return real_strtok != 0 ? real_strtok(text, delimiters) : 0;
}

int _ZNK17storeservicescore20AuthenticateResponse12responseTypeEv(
  void *response
) {
  typedef int (*response_type_fn)(void *);
  typedef union std_string *(*customer_message_fn)(void *);
  typedef struct shared_ptr *(*response_error_fn)(void *);
  typedef int (*error_code_fn)(void *);
  typedef const char *(*error_what_fn)(void *);

  static response_type_fn real_response_type;
  static customer_message_fn customer_message;
  static response_error_fn response_error;
  static error_code_fn error_code;
  static error_what_fn error_what;

  if (real_response_type == 0) {
    real_response_type = (response_type_fn)dlsym(
      RTLD_NEXT,
      "_ZNK17storeservicescore20AuthenticateResponse12responseTypeEv"
    );
  }
  if (real_response_type == 0) return 0;

  const int response_type = real_response_type(response);
  if (response_type == 6) return response_type;

  if (customer_message == 0) {
    customer_message = (customer_message_fn)dlsym(
      RTLD_NEXT,
      "_ZNK17storeservicescore20AuthenticateResponse15customerMessageEv"
    );
    response_error = (response_error_fn)dlsym(
      RTLD_NEXT,
      "_ZNK17storeservicescore20AuthenticateResponse5errorEv"
    );
    error_code = (error_code_fn)dlsym(
      RTLD_NEXT,
      "_ZNK17storeservicescore19StoreErrorCondition9errorCodeEv"
    );
    error_what = (error_what_fn)dlsym(
      RTLD_NEXT,
      "_ZNK17storeservicescore19StoreErrorCondition4whatEv"
    );
  }

  if (customer_message != 0) {
    const char *message = std_string_data(customer_message(response));
    if (message != 0 && *message != '\0') {
      write_text("[!] server message: ");
      write_text(message);
      write_text("\n");
    }
  }

  if (response_error != 0) {
    struct shared_ptr *error = response_error(response);
    if (error != 0 && error->obj != 0) {
      write_text("[!] auth error: code=");
      write_number(error_code != 0 ? error_code(error->obj) : 0);
      write_text(", message=");
      write_text(error_what != 0 ? error_what(error->obj) : "none");
      write_text("\n");
      return response_type;
    }
  }

  write_text("[!] auth failed: response type ");
  write_number(response_type);
  write_text("\n");
  return response_type;
}
