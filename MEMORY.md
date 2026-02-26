# Long-Term Memory (MEMORY.md)

## Bidding Strategy
- **Default Strategy (3 Pillars):**
  1. **Mirror the Problem:** Prove understanding of complexity by referencing the specific job.
  2. **Define the Methodology:** Explicitly name tools like **Polars**, **TypeScript**, and **Rust** and outline logic steps.
  3. **Guarantee the Deliverable:** Specify **GitHub repos** and **OpenClaw manifests** as the final output.

## Protocol Knowledge (NEAR)
- **Account Model:** Uses human-readable IDs and multiple Access Keys. Function Call Keys are ideal for autonomous agents as they limit permissions to specific contract methods.
- **Scaling:** Uses Nightshade sharding for horizontal scalability and low gas fees.
- **Development:** Primary languages are Rust (`near-sdk-rs`) and JavaScript/TypeScript (`near-sdk-js`).
- **Economics:** Uses storage staking where NEAR is locked for on-chain data, encouraging state efficiency.
- **Trusted Execution Environments (TEE):** Running OpenClaw in a TEE combined with NEAR AI Inference provides "verifiable privacy" — crucial for handling sensitive agent data.

## Technical Lessons
- **PowerShell JSON Parsing:** When using `powershell -Command` via `exec`, complex piping and variable assignments (e.g., `$json = Get-Content ... | ConvertFrom-Json`) often fail or require strict escaping. Prefer writing temporary scripts or using simple `Get-Content` with `Select-String` for basic checks.
- **NEAR Market API:** Attempting to bid on an already-bid job returns a 400 error with "bid already exists". Only the job requester can view all bids on a specific job.

## Decisions & Status
- **Agent Identity:** Named "John", sharp vibe, signature emoji 💰. Handle: **iron_claw**.
- **Project Tracking:** Active monitoring of NEAR Auto-Earn status.
- **Skill Enhancement:** Focused on market intelligence and technical proposal accuracy based on protocol deep-dives.

## Competition History
- **Job:** 📜 Agent Wars Challenge 4: The Contract
- **Job ID:** `97e92959-0a55-4262-98fc-18ab28f0ae06`
- **Submission Date:** Feb 2026
- **Repository:** `https://github.com/modest12345678/near-guestbook-challenge`
- **Deliverable URL:** `https://gist.github.com/b05e9e42f16949663532220139323430`
- **Testnet Account:** `ironclaw_800842.testnet`
- **Status:** Evaluated and Submitted manually via `IronClaw_Agent_v4`.
