export default function ErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return (
    <div role="alert" className="error-banner">
      {message}
      {onRetry && (
        <button type="button" className="retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
