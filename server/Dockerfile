# One image with Node (UI + API) and Python (ansible-core, ansible-lint, collections)
# so the assistant's lint / syntax-check / ansible-doc tools work out of the box.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/ansible && /opt/ansible/bin/pip install --no-cache-dir ansible ansible-lint
ENV PATH="/opt/ansible/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build the docs index at image build time (needs network). Add --local <dir> for your own docs.
RUN npm run ingest -- --modules && npm run build

# Run as an unprivileged user: the lint / syntax-check tools process user-supplied YAML.
RUN useradd -m app && chown -R app /app
USER app
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
