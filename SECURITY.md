# Security policy

fiber-servo drives a container runtime. A bug in the executor can create,
replace, or delete containers on the host it runs on, so please treat
anything that lets a tree do more than it says as a security issue.

## Reporting

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on the repository ("Security" tab, "Report a
vulnerability"). You should hear back within a week.

## Scope

In scope:

- Ops emitted that do not correspond to the rendered tree
- Argument injection into `nerdctl` argv from spec fields (names, images,
  env, labels, commands)
- The event watcher acting on containers it does not own

Out of scope:

- Weaknesses of containerd, nerdctl, CNI, or the images you run
- Running fiber-servo with more privileges than it needs

## Supported versions

Only the latest release receives fixes.
