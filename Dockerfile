FROM node:24.22.2-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
# The whole context (.dockerignore keeps node_modules out). Branding is not built in: the server reads ASSETS_DIR.
COPY . /app/
# Build-time settings: unset keeps the defaults in web/src/config.ts.
ARG CHUNK_SIZE WINDOW MAX_DIRECT TURN_QUOTA BUFFER_HIGH BUFFER_LOW STEP_MS GAIN LANE_OPEN_MS ACK_EVERY ACK_MS \
    ACCESS_LEN SECRET_LEN KEEP_ALIVES KEEP_ALIVE
RUN npm run build

FROM rust:1.98.1-slim-bookworm AS server
WORKDIR /app
ENV E2FT_WEB_PREBUILT=1
COPY Cargo.toml Cargo.lock build.rs ./
# Dependencies alone, in a layer the registry cache keeps (buildx does not export cache mounts).
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY src ./src
COPY --from=web /app/web/dist ./web/dist
# The server's copies of the settings, which must match the web stage's.
ARG ACCESS_LEN KEEP_ALIVES KEEP_ALIVE
RUN touch src/main.rs && cargo build --release --locked --offline

# nonroot tag, pinned by digest
FROM gcr.io/distroless/cc-debian12@sha256:e5d81ddde149641e2a9ba55be4545bc125c67de07508b03ba4c22e6eb0ded5aa
COPY --from=server /app/target/release/e2ft /e2ft
ENV ADDR=0.0.0.0:8080
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/e2ft"]
