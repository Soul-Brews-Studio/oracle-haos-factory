export default function AsyncNotice({ loading, error, label = "data" }: { loading: boolean; error: string; label?: string }) {
  if (error) return <div className="notice notice-error" role="alert"><strong>Could not load {label}.</strong><span>Check that LINE Lance is running, then reload this view.</span></div>;
  if (loading) return <div className="notice" role="status"><span className="notice-spinner" aria-hidden="true" />Loading {label}…</div>;
  return null;
}
