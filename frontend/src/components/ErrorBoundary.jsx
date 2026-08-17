import { Component } from "react";

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
    // eslint-disable-next-line no-console
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-lg px-6 py-24 text-center">
          <h1 className="text-xl font-bold text-stone-900">Something went wrong</h1>
          <p className="mt-2 text-sm text-stone-500">
            {this.state.error.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.assign(window.location.pathname)}
            className="mt-5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
