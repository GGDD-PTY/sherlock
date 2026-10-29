# Analytics implementation

Analytics requires the operator's own PostHog project key. Without it, the analytics client does not initialize. Local development is off unless explicitly enabled.

The client uses `persistence: 'localStorage'` rather than analytics cookies. Browser Do Not Track and Global Privacy Control signals are respected. Session Replay masks personal content according to the source configuration. Review these settings before enabling analytics for your own deployment.

Authentication session cookies are separate from analytics storage. Each operator must publish privacy information that accurately describes their configuration and data processing.
