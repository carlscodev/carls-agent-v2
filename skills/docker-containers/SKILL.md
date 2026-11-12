---
name: docker-containers
description: Build and run containers well: Dockerfiles, layer caching, multi-stage builds, compose and security.
version: 1
when_to_use: Use when writing a Dockerfile, debugging an image, or setting up containers.
tags: [docker container dockerfile multi-stage compose image caching security]
---
# Containers

## Dockerfile

- Multi-stage: build in a full image, copy artifacts into a minimal runtime
  (`distroless`, `alpine`, `slim`). Ship no compilers.
- Order layers by change frequency: dependencies first, source last. This is the
  difference between a 5-second and a 5-minute rebuild.
- One `RUN` per logical step, chained with `&&`, cleaning package caches in the
  same layer.
- Pin base image digests or at least minor versions. `latest` breaks builds.
- `COPY package.json package-lock.json ./` then install, then `COPY . .`.
- Add `.dockerignore` for `node_modules`, `.git`, `dist`, secrets.

## Runtime

- Run as a non-root user: `USER app`. Create it explicitly.
- One process per container. Use an init (`--init` or `tini`) when you spawn
  children, so signals and zombies are handled.
- `EXPOSE` documents the port; it does not publish it.
- Health check that actually checks readiness, not just that the process exists.
- Set `STOPSIGNAL SIGTERM` and handle it: finish in-flight work, then exit.

## Security

- Never bake secrets into an image; they live in the layer history forever. Pass
  them at runtime.
- Read-only root filesystem where possible, with a tmpfs for scratch.
- Drop capabilities; add back only what is needed.
- Scan images (`trivy`, `grype`) in CI and fail on high findings.

## Compose and local dev

- `depends_on` with `condition: service_healthy`, not just the name.
- Named volumes for data, bind mounts for source. Do not lose a database to a
  container restart.
- Pin image tags in compose files too.

## Debugging

- `docker run --rm -it <image> sh` to inspect the real image.
- `docker exec` into a running container, but remember the state is ephemeral.
- `docker system df` before blaming the disk.
