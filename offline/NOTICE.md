# Licences of the offline index content

This folder holds documentation text from two sources, plus enrichment written from it. They are separate works shipped side by side; every passage in the index carries its own `lic` field, and the app shows it with the source link under each result.

| Content | Source | Licence |
| --- | --- | --- |
| `chunks/ansible-core-*.jsonl` and the enrichment files for those chunks | [ansible/ansible-documentation](https://github.com/ansible/ansible-documentation) and ansible-core plugin docs, © Ansible project contributors | GPL-3.0-or-later |
| `chunks/aap-*.jsonl` and the enrichment files for those chunks | [ansible/aap-docs](https://github.com/ansible/aap-docs) (published at [docs.redhat.com](https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/2.6)), © Red Hat, Inc. | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Pipeline and app code | this repository | the repository's licence |

To tell which licence an `enrichment/<chunk_hash>.json` file is under, look up its hash in `chunks/*.jsonl`: the file name of the list it is in, and the `licence` field of that chunk, say which.

## Red Hat Ansible Automation Platform documentation

- Attribution: Red Hat Ansible Automation Platform 2.6 documentation, © Red Hat, Inc., from https://github.com/ansible/aap-docs at the commit pinned in `pipeline/config.ts`, under CC BY-SA 4.0.
- Changes: the AsciiDoc books were converted to Markdown-like text and split into passages. Each passage was given an AI-written summary, a list of questions and, for some, an answer card. Those adaptations are shared under CC BY-SA 4.0, the same licence.
- Every passage and answer card links to the page it came from on docs.redhat.com.
- Red Hat, Ansible and Ansible Automation Platform are trademarks of Red Hat, Inc. The licence does not cover trademarks; this project is not made or endorsed by Red Hat and does not use Red Hat logos.

This file describes how the content is labelled. It is not legal advice.
