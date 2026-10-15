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
- Two business rules on `sc_req_item`:
  - **gate (sync)**: decides right after insert, when catalog variables exist; creates the approval for
    REVIEW and error; any exception becomes ERROR, which waits for a person.
  - **guard**: runs last on every update of a gated item (and of any item moved away from it). The
    verdict of record is the first "DugganUSA Membrane verdict" work note in the journal, never an
    editable field. No verdict means ERROR. BLOCK stays rejected and closed. REVIEW and ERROR stay
    "requested", and can't be closed complete, until a person's approval record says approved.

Undo: delete the Script Include, the catalog item and the rules named "DugganUSA Membrane". Nothing
else is changed.

## What leaves your instance

Only the package name, ecosystem and version you're checking. Nothing about the requester, your
instance or your data.

## Verified (adversarially)

ServiceNow Brazil developer instance, 2026-10-15:

| Test | Result |
|---|---|
| npm zod 3.23.8 / npm lodash 4.17.21 / RubyGems eth-keystore-utils | approved / requested / rejected + Closed Incomplete |
| Rewrite the display field to "allow", then approve a BLOCK | reverted: rejected, closed |
| Set a REVIEW to "not required" | reverted to requested |
| Close a REVIEW as complete without approval | reverted to open |
| Move a REVIEW to another catalog item, then approve | catalog item restored, approval reverted |
| The platform's own request-level cascade | reverted (logged) |
| A person approves the approval record, then the item | approved, as intended |

**How it got here.** Three automated security reviews, three fixes, all the same day: v1 ran async and the
platform's auto-approval cascaded over REVIEW and BLOCK (fail-open); v2 trusted an editable field and
missed "not required", "closed complete", and a missing verdict; v3 reads the verdict from the
journal, fails closed on no verdict, and guards every route above.

**Limits, stated plainly.** Business rules can't stop an instance admin who edits the journal,
deactivates the rules, or runs a script with `setWorkflow(false)`. That's platform admin power; pair
this with your change-control and admin-audit policies, which is what they're for.

## Threat intelligence in the SOC module

Customers licensed for Threat Intelligence Security Center can add the DugganUSA feed as a TAXII 2.1
source. Use HTTP Basic with any username and your API key as the password.
