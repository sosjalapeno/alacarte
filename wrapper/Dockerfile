FROM debian:stable-slim

ENV args=""

RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*

COPY ./rootfs /app/rootfs
COPY ./wrapper /app
COPY ./preload_host.c ./preload_libdl_stub.c ./wrapper_login_fix.c /app/
WORKDIR /app

RUN gcc -shared -fPIC -O2 \
      -Wl,-soname,libwrapper_login_fix.so \
      -o /app/libwrapper_login_fix.so /app/preload_host.c \
  && mkdir -p /app/rootfs/app \
  && gcc -shared -fPIC -nostdlib -Wl,--hash-style=sysv \
      -Wl,-soname,libdl.so -o /tmp/libdl.so /app/preload_libdl_stub.c \
  && gcc -shared -fPIC -O2 -nostdlib -fno-stack-protector -fno-builtin \
      -fno-asynchronous-unwind-tables -Wl,--hash-style=sysv \
      -Wl,-soname,libwrapper_login_fix.so \
      -L/app/rootfs/system/lib64 -L/tmp \
      -o /app/rootfs/app/libwrapper_login_fix.so /app/wrapper_login_fix.c \
      -Wl,--no-as-needed -lc -ldl

CMD ["bash", "-c", "/app/wrapper $args"]

EXPOSE 10020 20020 30020
