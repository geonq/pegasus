import { describeProviderError } from "./provider-error";

/** An error as a plain sentence with the provider's own text behind a disclosure; unknown shapes show as sent. */
export function ErrorText({ text }: { readonly text: string }) {
  const plain = describeProviderError(text);
  if (!plain) return <>{text}</>;
  return (
    <span className="error-text">
      <span className="error-text__summary">{plain.summary}</span>
      <details className="error-text__details">
        <summary>Details</summary>
        <code>{plain.raw}</code>
      </details>
    </span>
  );
}
