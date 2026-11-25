/**
 * Хаб аналитики: группы отчётов со ссылками внутрь.
 */

import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { useAuth } from '../../context/AuthContext.jsx';
import { isNavFeatureEnabled } from '../../utils/userNavSections.js';
import { isProfileFboEnabled } from '../../utils/profileFlags.js';
import { filterAnalyticsGroups } from './analyticsNav.js';
import './AnalyticsHub.css';

export function AnalyticsHub() {
  const { isAccountAdmin, isAdmin, features, profile } = useAuth();
  const fboEnabled = isProfileFboEnabled(profile);

  const groups = useMemo(
    () =>
      filterAnalyticsGroups({
        features,
        isAccountAdmin,
        isAdmin,
        fboEnabled,
        isNavFeatureEnabled,
      }),
    [features, fboEnabled, isAccountAdmin, isAdmin]
  );

  return (
    <div className="analytics-hub">
      <PageTitle
        iconClass="pe-7s-graph2"
        iconBgClass="bg-mean-fruit"
        title="Аналитика"
        subtitle="Отчёты по продажам, ассортименту, потерям, финансам и операциям"
      />

      <div className="analytics-hub__groups">
        {groups.map((group) => {
          const first = group.reports[0];
          return (
            <section key={group.id} className="analytics-hub__group">
              <div className="analytics-hub__group-head">
                <div>
                  <h2 className="analytics-hub__group-title">
                    {first ? (
                      <Link to={first.to} className="analytics-hub__group-title-link">
                        {group.label}
                      </Link>
                    ) : (
                      group.label
                    )}
                  </h2>
                  {group.description ? (
                    <p className="analytics-hub__group-desc">{group.description}</p>
                  ) : null}
                </div>
              </div>
              <ul className="analytics-hub__reports">
                {group.reports.map((report) => (
                  <li key={report.to}>
                    <Link to={report.to} className="analytics-hub__report">
                      <span className="analytics-hub__report-label">{report.label}</span>
                      {report.description ? (
                        <span className="analytics-hub__report-desc">{report.description}</span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
