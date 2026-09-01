/*
 * The outer wrapper is a glibc binary, while the program it starts after
 * chrooting is an Android/bionic binary. LD_PRELOAD has to name the same path
 * on both sides of that boundary, so the host side only needs a valid glibc
 * object. The Android implementation lives at rootfs/app under the same path.
 */
int alacarte_wrapper_login_fix_host = 1;
