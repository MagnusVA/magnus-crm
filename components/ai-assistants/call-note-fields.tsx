import type { Doc } from "@/convex/_generated/dataModel";

/** Plain text throughout: notes can contain words supplied by a person. */
export function CallNoteFields({
  note,
}: {
  note: Pick<
    Doc<"callNotes">,
    "currentSituation" | "goal" | "bottleneck" | "objection" | "nextAction"
  >;
}) {
  return (
    <dl className="grid gap-2 text-sm">
      {[
        ["Current situation", note.currentSituation],
        ["Goal", note.goal],
        ["Bottleneck", note.bottleneck],
        ["Objection", note.objection],
        ["Next action", note.nextAction],
      ].map(([label, value]) =>
        value ? (
          <div key={label} className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="whitespace-pre-wrap break-words" translate="no">
              {value}
            </dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
