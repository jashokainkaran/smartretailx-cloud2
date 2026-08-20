import { Component } from "react";
import StatusPage from "./StatusPage.jsx";

// Without this, an uncaught error anywhere in the render tree unmounts the
// ENTIRE app (React 18's default) — a blank white page with no clue why.
// This turns that into a visible message, and logs the real error to the
// console so it's actually diagnosable instead of just "the page is blank."
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-lg px-6 py-16">
          <StatusPage
            variant="warning"
            tone="warning"
            title="Something went wrong"
            message={this.state.error.message || "An unexpected error occurred. Reloading usually fixes it."}
            action={{ label: "Reload", onClick: () => window.location.assign(window.location.pathname) }}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
