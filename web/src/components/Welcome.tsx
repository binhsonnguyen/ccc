export default function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>cc terminal</h1>
        <p>
          Pick a session from the sidebar to attach. PTYs keep running
          server-side when you close a tab — reopening reattaches to the same
          process.
        </p>
        <p className="muted">
          The CLI still works: <code>cc</code> / <code>claude --resume &lt;uuid&gt;</code>.
        </p>
      </div>
    </div>
  );
}
