import React from 'react';
import { Outlet } from 'react-router-dom';
import { AnalyticsSubNav } from './AnalyticsSubNav.jsx';

export function AnalyticsLayout() {
  return (
    <div>
      <AnalyticsSubNav />
      <Outlet />
    </div>
  );
}
