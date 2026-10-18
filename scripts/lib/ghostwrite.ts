// Shared ghostwrite assembly: the SOUL framing, the prompt builders, and the
// human-act guard. Both surfaces of the capability use this one copy — the CLI
// (scripts/ghostwrite.ts) and the display (scripts/serve.ts, POST /api/ghostwrite)
// — so there is a single definition of how a draft is assembled and when a real
// call is refused. See CONSTRAINTS.md item 10. No network code lives here; the
// outbound call stays in lib/ask.ts.
import { StoreError } from "./db";
import { heading, type Hit } from "../query";

export const SYSTEM_HEAD = `You are drafting as one specific person, using a distilled model of how they think, argue, and write. The profile below (SOUL) is built only from that person's own writing. Reason from their priors, make their moves, and write in their voice — short declaratives that turn, dash asides, their register. Ground claims in the numbered snippets from their own record wherever one applies, and cite the snippet number. Never put a belief in their mouth that the profile and snippets do not support; where their record is silent on a stance, write the open question they would ask rather than inventing a position. Produce a draft for them to review — do not address, greet, or sign as anyone.`;

/** Refuses a real (non-dry) draft when this process was started inside an AI
 *  coding session. Sending anything outbound — drafting as the operator — is a
 *  human act; the CLI and the display both call this before the model call. */
export function requireHumanOperator(dry = false): void {
  if (dry) return;
  if (process.env.CLAUDECODE) {
    throw new StoreError(
      "refusing to draft through the model from inside an AI coding session (CLAUDECODE is set) — " +
      "sending anything outbound is a human act here. Run this command yourself in a normal terminal. " +
      "--dry still works from here.",
    );
  }
}

export function buildSystem(soul: string): string {
  return `${SYSTEM_HEAD}\n\n── SOUL — how this person thinks, argues, and writes ──\n${soul}`;
}

export function buildUser(topic: string, hits: Hit[]): string {
  const snippets = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${heading(h)}\n${h.snippet}`).join("\n\n")
    : "(no matching snippets in the record — write from SOUL, and where their stance is unknown, surface the open question rather than inventing one)";
  return `Topic / prompt:\n${topic}\n\n── their own prior words (numbered snippets from the record) ──\n${snippets}\n\n── task ──\nDraft this as them. Use their priors and argumentative moves; keep their voice. Cite snippet numbers where a claim leans on one. End the way they end — on the reframed question, not a tidy bow.`;
}
