/*
 * Link-only stub. Android's linker provides libdl.so at runtime, but the
 * bundled rootfs does not contain a linkable copy for the image build.
 */
void *dlsym(void *handle, const char *symbol) {
  (void)handle;
  (void)symbol;
  return 0;
}
