import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(error, () => this.setState({ error: null }));
      }
      return (
        <div className="alert alert-danger m-3" role="alert">
          <div className="fw-semibold mb-2">Ошибка интерфейса</div>
          <div className="small mb-3" style={{ whiteSpace: 'pre-wrap' }}>
            {String(error?.message || error || 'Неизвестная ошибка')}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-outline-danger"
            onClick={() => window.location.reload()}
          >
            Обновить страницу
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
