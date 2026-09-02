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
#define MAX_PASSWORD_LEN 512
#define TWO_FA_SUFFIX_LEN 6
static char password_buffer[MAX_PASSWORD_LEN + TWO_FA_SUFFIX_LEN + 1];
static int login_split_active;

static size_type bounded_length(const char *text, size_type limit) {
  size_type length = 0;
  if (text == 0) return 0;
  while (length < limit && text[length] != '\0') length++;
  return length;
}

static void clear_login_split_state(void) {
  password_buffer[0] = '\0';
  login_split_active = 0;
}

static int copy_password_after_colon(char *separator) {
  const char *password = separator + 1;
  size_type length = bounded_length(password, MAX_PASSWORD_LEN + 1);

  if (length > MAX_PASSWORD_LEN) return 0;

  for (size_type i = 0; i <= length; i++) {
    password_buffer[i] = password[i];
  }
  return 1;
}

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

static void write_long(long value) {
  char digits[32];
  unsigned long magnitude;
  int cursor = (int)sizeof(digits);

  if (value < 0) {
    write_text("-");
    magnitude = 0UL - (unsigned long)value;
  } else {
    magnitude = (unsigned long)value;
  }

  do {
    digits[--cursor] = (char)('0' + (magnitude % 10UL));
    magnitude /= 10UL;
  } while (magnitude != 0UL);
  (void)write(2, digits + cursor, (size_type)((int)sizeof(digits) - cursor));
}

static int string_nonempty(const char *text) {
  return text != 0 && *text != '\0';
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
        if (!copy_password_after_colon(separator)) {
          clear_login_split_state();
          return real_strtok != 0 ? real_strtok(text, delimiters) : 0;
        }
        login_split_active = 1;
        return text;
      }
    } else if (text == 0 && login_split_active) {
      login_split_active = 0;
      return password_buffer[0] != '\0' ? password_buffer : 0;
    }
  }

  clear_login_split_state();
  return real_strtok != 0 ? real_strtok(text, delimiters) : 0;
}

int _ZNK17storeservicescore20AuthenticateResponse12responseTypeEv(
  void *response
) {
  typedef int (*response_type_fn)(void *);
  typedef union std_string *(*customer_message_fn)(void *);
  typedef struct shared_ptr *(*response_error_fn)(void *);
  typedef int *(*error_code_fn)(void *);
  typedef long *(*external_error_code_fn)(void *);
  typedef long *(*auth_status_fn)(void *);
  typedef const char *(*error_what_fn)(void *);
  typedef void (*error_description_fn)(union std_string *, void *);

  static response_type_fn real_response_type;
  static customer_message_fn customer_message;
  static response_error_fn response_error;
  static error_code_fn error_code;
  static external_error_code_fn external_error_code;
  static auth_status_fn auth_status;
  static error_what_fn error_what;
  static error_description_fn error_description;

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
    external_error_code = (external_error_code_fn)dlsym(
      RTLD_NEXT,
      "_ZNK17storeservicescore19StoreErrorCondition17externalErrorCodeEv"
    );
    auth_status = (auth_status_fn)dlsym(
      RTLD_NEXT,
      "_ZNK17storeservicescore20AuthenticateResponse6statusEv"
    );
    error_what = (error_what_fn)dlsym(
      RTLD_NEXT,
      "_ZNK17storeservicescore19StoreErrorCondition4whatEv"
    );
    error_description = (error_description_fn)dlsym(
      RTLD_NEXT,
      "_ZNK17storeservicescore19StoreErrorCondition16errorDescriptionEv"
    );
  }

  if (customer_message != 0) {
    const char *message = std_string_data(customer_message(response));
    if (string_nonempty(message)) {
      write_text("[!] server message: ");
      write_text(message);
      write_text("\n");
    }
  }

  if (response_error != 0) {
    struct shared_ptr *error = response_error(response);
    if (error != 0 && error->obj != 0) {
      int code = 0;
      long external = 0;
      long status = 0;
      const char *message = 0;

      if (error_code != 0) {
        int *code_ptr = error_code(error->obj);
        if (code_ptr != 0) code = *code_ptr;
      }
      if (external_error_code != 0) {
        long *external_ptr = external_error_code(error->obj);
        if (external_ptr != 0) external = *external_ptr;
      }
      if (auth_status != 0) {
        long *status_ptr = auth_status(response);
        if (status_ptr != 0) status = *status_ptr;
      }
      if (error_what != 0) {
        const char *what = error_what(error->obj);
        if (string_nonempty(what)) message = what;
      }
      if (!string_nonempty(message) && error_description != 0) {
        union std_string desc_out;
        error_description(&desc_out, error->obj);
        const char *desc = std_string_data(&desc_out);
        if (string_nonempty(desc)) message = desc;
      }
      if (!string_nonempty(message)) message = "none";

      write_text("[!] auth error: code=");
      write_number(code);
      write_text(", external=");
      write_long(external);
      write_text(", status=");
      write_long(status);
      write_text(", message=");
      write_text(message);
      write_text("\n");
      return response_type;
    }
  }

  write_text("[!] auth failed: response type ");
  write_number(response_type);
  write_text("\n");
  return response_type;
}

#ifdef TEST_HARNESS
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  char login_arg[] = "user@example.com:password:with:colons";
  char guard_before = (char)0xaa;
  char guard_after = (char)0xbb;
  char guards[2] = { guard_before, guard_after };

  char *user = strtok(login_arg, ":");
  assert(user != 0);
  assert(strcmp(user, "user@example.com") == 0);

  char *password = strtok(0, ":");
  assert(password != 0);
  assert(strcmp(password, "password:with:colons") == 0);

  const char *suffix = "123456";
  size_type suffix_len = bounded_length(suffix, TWO_FA_SUFFIX_LEN + 1);
  size_type password_len = bounded_length(password, MAX_PASSWORD_LEN + 1);
  assert(suffix_len == TWO_FA_SUFFIX_LEN);
  assert(password_len + suffix_len + 1 <=
         (size_type)(MAX_PASSWORD_LEN + TWO_FA_SUFFIX_LEN + 1));

  for (size_type i = 0; i < suffix_len; i++) {
    password[password_len + i] = suffix[i];
  }
  password[password_len + suffix_len] = '\0';

  assert(strcmp(password, "password:with:colons123456") == 0);
  assert(guards[0] == guard_before);
  assert(guards[1] == guard_after);

  printf("ok\n");
  return 0;
}
#endif
