# Cognitive Architecture: BDI Pattern & Internal Validation

## 🧠 BDI Pattern (Beliefs, Desires, Intentions)
The Iron Claw engine implements a modified **BDI Cognitive Architecture** to manage autonomous decision-making on the NEAR Agent Market.

### 1. Beliefs (The World State)
The agent maintains a real-time "Belief Map" based on:
- **Market Intel:** Current bid counts, average budget for technical tasks, and competitor reputation scores.
- **Requester Sentiment:** Historical analysis of how specific creators (like `ed3eec9a`) score deliverables.
- **System Health:** CPU/RAM availability for heavy data engineering tasks (e.g., Polars runs).

### 2. Desires (Objectives)
The engine prioritizes desires based on the user's strategic goals:
- **Primary:** Reputation Breakout (Priority High).
- **Secondary:** Capital Generation (Priority Medium).
- **Tertiary:** Ecosystem Authority (Priority Low).

### 3. Intentions (The Plan)
Once a Desire is selected (e.g., "Win a High-Budget AI Job"), the agent commits to an **Intention**. This intention is locked into a multi-step execution plan in `scripts/auto-earn.js` and cannot be interrupted until completion or technical failure.

---

## ⚖️ Internal Validation: LLM-as-a-Judge
To eliminate the risk of "Low Quality" or "Broken" deliveries, we utilize a specialized **EvaluatorAgent**.

### The Rubric
Before any submission, the `EvaluatorAgent` grades the work on a 1-100 scale based on:
- **Functional Completeness:** Does it meet every bullet point in the job description?
- **Code Quality:** Is it dry, documented, and following first-principles (BYOX) patterns?
- **Test Coverage:** Are the unit tests comprehensive and passing?
- **UX/README:** Is the solution "one-command" ready for the requester?

### The 95% Threshold
The system is hard-coded with a **95% Acceptance Threshold**.
- **Score >= 95:** Proceed to Pre-Flight Check and Submission.
- **Score < 95:** The agent generates an "Audit Deficiency Report" and feeds it back into the Kilo CLI for a targeted refactor. This loop continues until the 95% threshold is crossed.

---

## 🗜️ Context Engineering & Progressive Disclosure
Traditional agents fail on complex tasks because they overload their context window. Iron Claw uses **Progressive Disclosure**:
1. **Module level:** Kilo only "sees" the requirements for the specific module it is currently building.
2. **Abstract level:** Technical topography is compressed into high-signal Markdown fragments.
3. **Reference level:** The Build-Your-Own-X (BYOX) logic is injected only when a specific technical pattern is required.

---
*Blueprint for Elite Cognitive Performance.*
