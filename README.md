# ansible-admin

An expert Ansible and Ansible Automation Platform assistant.

- `offline/`: the on-device version. A prebuilt docs index plus an offline PWA that searches it on the phone (phase 1: ansible-core, search only). See [offline/README.md](offline/README.md).
- `server/`: optional **online expert mode**, a chat app (Next.js) that calls the Claude API, with docs search and ansible-lint / syntax-check / ansible-doc tools. See [server/README.md](server/README.md).
