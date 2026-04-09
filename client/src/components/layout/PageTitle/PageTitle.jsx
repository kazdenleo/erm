import React from 'react';

export function PageTitle({ iconClass = 'pe-7s-graph2', iconBgClass = 'bg-mean-fruit', title, subtitle, actions }) {
  return (
    <div className="app-page-title">
      <div className="page-title-wrapper">
        <div className="page-title-heading">
          <div className="page-title-icon">
            <i className={`${iconClass} icon-gradient ${iconBgClass}`} />
          </div>
          <div>
            {title}
            {subtitle ? <div className="page-title-subheading">{subtitle}</div> : null}
          </div>
        </div>
        {actions ? <div className="page-title-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

