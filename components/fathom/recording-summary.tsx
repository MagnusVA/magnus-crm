import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// Fathom writes summaries as GitHub-flavored Markdown: headings per section,
// and bullets whose text links to a moment in the recording. Raw HTML in the
// summary is not rendered, and unsafe link protocols are dropped.
const components: Components = {
  h1: ({ node: _node, ...props }) => (
    <h3 className="mt-5 text-base font-semibold first:mt-0" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h3 className="mt-5 text-[0.9375rem] font-semibold first:mt-0" {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h4 className="mt-4 text-sm font-semibold first:mt-0" {...props} />
  ),
  h4: ({ node: _node, ...props }) => (
    <h5
      className="mt-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:mt-0"
      {...props}
    />
  ),
  p: ({ node: _node, ...props }) => <p className="mt-2 first:mt-0" {...props} />,
  ul: ({ node: _node, ...props }) => (
    <ul
      className="mt-2 list-disc space-y-1.5 pl-5 marker:text-muted-foreground first:mt-0 [&_ul]:mt-1.5"
      {...props}
    />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol
      className="mt-2 list-decimal space-y-1.5 pl-5 marker:text-muted-foreground first:mt-0 [&_ol]:mt-1.5"
      {...props}
    />
  ),
  li: ({ node: _node, ...props }) => <li className="pl-0.5" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a
      className="underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  strong: ({ node: _node, ...props }) => (
    <strong className="font-semibold" {...props} />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className="mt-2 border-l-2 pl-3 text-muted-foreground first:mt-0"
      {...props}
    />
  ),
  code: ({ node: _node, ...props }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8125rem]" {...props} />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className="mt-2 overflow-x-auto rounded-md bg-muted p-3 first:mt-0 [&_code]:bg-transparent [&_code]:p-0"
      {...props}
    />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-4" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="mt-2 overflow-x-auto first:mt-0">
      <table className="w-full border-collapse text-left" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className="border-b px-2 py-1 font-medium" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border-b px-2 py-1 align-top" {...props} />
  ),
};

/** Renders a Fathom summary's Markdown with the app's type scale. */
export function RecordingSummary({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  return (
    <div className={cn("text-sm leading-relaxed break-words", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
