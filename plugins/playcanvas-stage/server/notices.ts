// the lines a notice (the comment monitor, the codex watcher, the prompt hook) gives the session
export type Pending = { id: string; title: string; count: number; withdrawn?: string[]; url: string };

export const noticeLines = (p: Pending, hook = false) => [
    ...(p.withdrawn ?? []).map(
        (t) =>
            `the user deleted comment thread ${t} on the stage "${p.title}" (${p.url}) before you answered it — discard that request: stop working on it, revert the changes you made for it (only those), and do not reply to or resolve it.`
    ),
    ...(p.count
        ? [
              `${p.count} comment${p.count > 1 ? 's were' : ' was'} sent to the agent on the stage "${p.title}" (${p.url}) — read ${p.count > 1 ? 'them' : 'it'} with StageComments action "read" and that url${hook ? '' : `, act on ${p.count > 1 ? 'them' : 'it'}, then reply and resolve`}.`
          ]
        : [])
];
