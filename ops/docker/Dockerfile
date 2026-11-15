FROM node:24.22.2-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
# The whole context, app/ (Dockerfile.dockerignore beside this file keeps node_modules out). Branding is not built
# in: the server reads ASSETS_DIR.
COPY . /app/
RUN npm run build

FROM rust:1.98.1-slim-bookworm AS server
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
# Dependencies alone, in a layer the registry cache keeps (buildx does not export cache mounts).
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY src ./src
COPY --from=web /app/web/dist ./web/dist
RUN touch src/main.rs && cargo build --release --locked --offline

# nonroot tag, pinned by digest
FROM gcr.io/distroless/cc-debian12@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=server /app/target/release/e2ft /e2ft
ENV ADDR=0.0.0.0:8080
EXPOSE 8080
USER 65532:65532
# The binary checks itself (no shell or curl here): the page, then each TURN server in TURN_URLS with a signed
# credential. Its own budget is 4 seconds. Podman keeps a HEALTHCHECK only in --format docker images.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/e2ft", "--health"]
ENTRYPOINT ["/e2ft"]
