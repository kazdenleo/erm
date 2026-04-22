/**
 * App Component
 * Главный компонент приложения
 */

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { ProtectedRoute } from './components/ProtectedRoute.jsx';
import { Layout } from './components/layout/Layout/Layout';
import { Login } from './pages/Login/Login';
import { PublicRegister } from './pages/Register/PublicRegister.jsx';
import { FirstLoginChangePassword } from './pages/FirstLoginChangePassword/FirstLoginChangePassword.jsx';
import { Home } from './pages/Home/Home';
import { Products } from './pages/Products/Products';
import { Warehouses } from './pages/Warehouses/Warehouses';
import { Suppliers } from './pages/Suppliers/Suppliers';
import { Orders } from './pages/Orders/Orders';
import { Questions } from './pages/Questions/Questions';
import { Reviews } from './pages/Reviews/Reviews';
import { OrderDetail } from './pages/Orders/OrderDetail';
import { Shipments } from './pages/Shipments/Shipments';
import { Assembly } from './pages/Assembly/Assembly';
import { StockLevelsLayout } from './pages/StockLevels/StockLevelsLayout';
import { SupplierStocks } from './pages/StockLevels/SupplierStocks';
import { WarehouseStocks } from './pages/StockLevels/WarehouseStocks';
import { Purchases } from './pages/StockLevels/Purchases';
import { Integrations } from './pages/Integrations/Integrations';
import { Notifications } from './pages/Notifications/Notifications';
import { Categories } from './pages/Categories/Categories';
import { Brands } from './pages/Brands/Brands';
import { Prices } from './pages/Prices/Prices';
import { Settings } from './pages/Settings/Settings';
import { Attributes } from './pages/Settings/Attributes';
import { Labels } from './pages/Settings/Labels';
import { Organizations } from './pages/Organizations/Organizations';
import { SettingsUsers } from './pages/Settings/Users/Users';
import { Admin } from './pages/Admin/Admin';
import { Cabinet } from './pages/Cabinet/Cabinet';
import { Support } from './pages/Support/Support';
import { PlatformLayout } from './platform/PlatformLayout.jsx';
import { PlatformRoute } from './platform/PlatformRoute.jsx';
import { PlatformInquiries } from './platform/PlatformInquiries.jsx';
import { PlatformMarketplaceNotifications } from './platform/PlatformMarketplaceNotifications.jsx';
import './App.css';
import './styles/mp-badges.css';
import './styles/erp-filter-bar.css';

function App() {
  return (
    <BrowserRouter future={{ v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/platform-login" element={<Login mode="platform" />} />
          <Route path="/register" element={<PublicRegister />} />
          <Route
            path="/first-login-change-password"
            element={
              <ProtectedRoute>
                <FirstLoginChangePassword />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<ProtectedRoute><Layout><Home /></Layout></ProtectedRoute>} />
          <Route path="/admin" element={<Navigate to="/platform-login" replace />} />
          <Route
            path="/platform"
            element={
              <ProtectedRoute>
                <PlatformRoute>
                  <PlatformLayout />
                </PlatformRoute>
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/platform/accounts" replace />} />
            <Route path="accounts" element={<Admin />} />
            <Route path="inquiries" element={<PlatformInquiries />} />
            <Route path="notifications" element={<PlatformMarketplaceNotifications />} />
          </Route>
          <Route path="/cabinet" element={<ProtectedRoute><Layout><Cabinet /></Layout></ProtectedRoute>} />
          <Route path="/support" element={<ProtectedRoute><Layout><Support /></Layout></ProtectedRoute>} />
          <Route path="/products" element={<ProtectedRoute><Layout><Products /></Layout></ProtectedRoute>} />
          <Route path="/stock-levels" element={<ProtectedRoute><Layout><StockLevelsLayout /></Layout></ProtectedRoute>}>
            <Route index element={<Navigate to="/stock-levels/suppliers" replace />} />
            <Route path="suppliers" element={<SupplierStocks />} />
            <Route path="warehouse" element={<WarehouseStocks />} />
            <Route path="purchases" element={<Purchases />} />
            <Route path="problems" element={<Navigate to="/stock-levels/warehouse" replace />} />
          </Route>
          <Route path="/warehouses" element={<ProtectedRoute><Layout><Warehouses /></Layout></ProtectedRoute>} />
          <Route path="/suppliers" element={<ProtectedRoute><Layout><Suppliers /></Layout></ProtectedRoute>} />
          <Route path="/orders" element={<ProtectedRoute><Layout><Orders /></Layout></ProtectedRoute>} />
          <Route path="/questions" element={<ProtectedRoute><Layout><Questions /></Layout></ProtectedRoute>} />
          <Route path="/reviews" element={<ProtectedRoute><Layout><Reviews /></Layout></ProtectedRoute>} />
          <Route path="/orders/:marketplace/:orderId" element={<ProtectedRoute><Layout><OrderDetail /></Layout></ProtectedRoute>} />
          <Route path="/shipments" element={<ProtectedRoute><Layout><Shipments /></Layout></ProtectedRoute>} />
          <Route path="/assembly" element={<ProtectedRoute><Layout><Assembly /></Layout></ProtectedRoute>} />
          <Route path="/categories" element={<ProtectedRoute><Layout><Categories /></Layout></ProtectedRoute>} />
          <Route path="/brands" element={<ProtectedRoute><Layout><Brands /></Layout></ProtectedRoute>} />
          <Route path="/prices" element={<ProtectedRoute><Layout><Prices /></Layout></ProtectedRoute>} />
          <Route path="/integrations" element={<ProtectedRoute><Layout><Integrations /></Layout></ProtectedRoute>} />
          <Route path="/notifications" element={<ProtectedRoute><Layout><Notifications /></Layout></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Layout><Settings /></Layout></ProtectedRoute>} />
          <Route path="/settings/attributes" element={<ProtectedRoute><Layout><Attributes /></Layout></ProtectedRoute>} />
          <Route path="/settings/labels" element={<ProtectedRoute><Layout><Labels /></Layout></ProtectedRoute>} />
          <Route path="/settings/users" element={<ProtectedRoute><Layout><SettingsUsers /></Layout></ProtectedRoute>} />
          <Route path="/organizations" element={<ProtectedRoute><Layout><Organizations /></Layout></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

