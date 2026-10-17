"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/**
 * Renders an answer as Markdown with GitHub-flavoured extensions (tables, task
 * lists, strikethrough) and syntax-highlighted code blocks.
 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="batch-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
