import {Component, type ErrorInfo, type ReactNode} from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Optional label shown in the fallback so the user knows which area crashed. */
  label?: string;
};

type ErrorBoundaryState = {
  error: Error | null;
};

/**
 * Catches render-time exceptions in any descendant so a single component crash
 * shows a recoverable error card instead of blanking the whole WebView.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {error: null};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {error};
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[error-boundary] render crashed", error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h2>Something went wrong{this.props.label ? ` in ${this.props.label}` : ""}</h2>
          <pre className="error-boundary-detail">{this.state.error.message}</pre>
          <button type="button" className="error-boundary-reload" onClick={this.handleReload}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
