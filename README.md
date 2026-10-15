# DugganUSA Membrane for ServiceNow

Verdicts as approval stages. A catalog request to install a software package is checked by the
DugganUSA Membrane before anyone acts on it:

| Verdict | What happens | Why |
|---|---|---|
| ALLOW  | Approved automatically | Not on the malicious-package deny-list, no known vulnerabilities in that version |
| REVIEW | An approval is created for a person | Known vulnerabilities, or a package with a history of compromised versions |
| BLOCK  | Rejected and closed, with the reason | On the deny-list (malicious) |
| error  | Waits for a person, never auto-approved | The check couldn't run, so nothing is assumed |

Every verdict, its reason and its source are written to the request's work notes: ServiceNow's own
audit trail.

## Install (about two minutes)

1. Log in as an admin. Open **System Definition > Scripts - Background**.
2. Paste `membrane-approval-setup.js`, leave **Record for rollback** checked, and **Run script**.
3. Set `APPROVER_USER` at the top of the script to the person or role owner who should approve REVIEW
   items (default `admin`).

It's idempotent: run it again to update the same records.

## What it creates (and how to remove it)

- Script Include `DugganUSAMembrane`: calls the public package check (no API key needed).
- Catalog item **Install a software package** with three variables: name, ecosystem, version.
- An admin-only, private system property `dugganusa.membrane.seal_secret` (created once).
- Two business rules on `sc_req_item`:
  - **gate (sync)**: decides right after insert, when catalog variables exist. It writes the verdict to
    the work notes with a **seal**, a SHA-256 over the item, the verdict and the exact package values,
    keyed by the admin-only secret. It also creates the approval for REVIEW and error. Any exception
    becomes ERROR, which waits for a person.
  - **guard**: runs last on every update of a gated item, and of any item moved away from it. It honors
    only a verdict whose seal verifies and whose package values still match the item, so a forged
    note, an edited package or a missing note all mean ERROR. BLOCK stays rejected and closed. REVIEW
    and ERROR stay "requested", and can't be closed complete, until someone **other than the requester
    or opener** approves.

`APPROVER_USER` is pinned in the admin-only property `dugganusa.membrane.approver`. Only that person's
approval releases a REVIEW or ERROR item, and never for a request they made or opened themselves. Choose
someone who doesn't request packages.

**Status: reference implementation.** Automated security reviews broke every version the day it was written.
Each finding is fixed and tested above. Have your ServiceNow security team review it before production,
and keep the guard's ordering (it must run last) intact.

Undo: delete the Script Include, the catalog item and the rules named "DugganUSA Membrane". Nothing
else is changed.

## What leaves your instance

Only the package name, ecosystem and version you're checking. Nothing about the requester, your
instance or your data.

## Verified (adversarially)

ServiceNow Brazil developer instance, 2026-10-15, v4.1:

| Test | Result |
|---|---|
| npm zod 3.23.8 / npm lodash 4.17.21 / RubyGems eth-keystore-utils | approved / requested / rejected + Closed Incomplete |
| Forged ALLOW note with a fake seal on a BLOCK, then approve | rejected, closed |
| Forged unsealed ALLOW note on a REVIEW, then approve | requested |
| Swap an ALLOW item's package to a malicious one | verdict void, back to requested |
| Requester approves their own REVIEW | refused, requested |
| Set a REVIEW to "not required" / close it as complete | reverted (v3 tests) |
| Move a REVIEW to another catalog item, then approve | restored, reverted (v3 tests) |
| The platform's own request-level cascade | reverted (logged) |
| A different person approves | approved, as intended |

**How it got here.** Automated security reviews broke each version the same day it was written,
and each finding became a fix:

- v1 ran async, so the platform's auto-approval cascaded over REVIEW and BLOCK.
- v2 trusted an editable field.
- v3 trusted any work note and allowed self-approval and package swaps.
- v4 rejected genuine seals because the digest is uppercase; it failed closed, so nothing slipped through.

**Limits, stated plainly.** Business rules can't stop an instance admin who edits the journal,
deactivates the rules, or runs a script with `setWorkflow(false)`. That's platform admin power; pair
this with your change-control and admin-audit policies, which is what they're for.

## Threat intelligence in the SOC module

Customers licensed for Threat Intelligence Security Center can add the DugganUSA feed as a TAXII 2.1
source. Use HTTP Basic with any username and your API key as the password.
