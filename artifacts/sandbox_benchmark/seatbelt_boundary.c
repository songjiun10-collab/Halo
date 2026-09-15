/* Trusted startup followed by a policy with no permissions. Diagnostic only. */
#include <sandbox.h>
#include <sys/statvfs.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    char *error = NULL;
    if (sandbox_init("(version 1)(deny default)", 0, &error)) {
        fprintf(stderr, "sandbox_init failed: %s\n", error);
        sandbox_free_error(error);
        return 2;
    }
    errno = 0;
    int cd = chdir(argv[1]);
    int cd_errno = errno;
    struct statvfs stats;
    errno = 0;
    int st = statvfs(argv[1], &stats);
    int st_errno = errno;
    printf("{\"sandbox_initialized\":true,\"chdir_rc\":%d,\"chdir_errno\":%d,"
           "\"statvfs_rc\":%d,\"statvfs_errno\":%d}\n", cd, cd_errno, st, st_errno);
    /* A failed syscall must be an actual policy denial, not e.g. ENOENT. */
    if (cd == 0 || st == 0) return 1;
    return (cd_errno == EPERM || cd_errno == EACCES) &&
           (st_errno == EPERM || st_errno == EACCES) ? 0 : 2;
}
