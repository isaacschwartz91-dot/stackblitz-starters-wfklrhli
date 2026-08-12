import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, clearSession, getStoredUser, getToken, setUnauthorizedHandler, storeSession } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => getStoredUser());
  const [checking, setChecking] = useState(() => Boolean(getToken()));

  const signOut = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

  // A token in localStorage may have expired while the tab was closed.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    if (!getToken()) return;

    let cancelled = false;
    api.get('/api/auth/me')
      .then((data) => !cancelled && setUser(data.user))
      .catch(() => !cancelled && signOut())
      .finally(() => !cancelled && setChecking(false));

    return () => { cancelled = true; };
  }, [signOut]);

  const signIn = useCallback(async (email, password) => {
    const data = await api.post('/api/auth/login', { email, password });
    storeSession(data);
    setUser(data.user);
    return data.user;
  }, []);

  const value = useMemo(
    () => ({
      user,
      checking,
      signIn,
      signOut,
      isDriver: user?.role === 'driver',
      isStaff: user?.role === 'admin' || user?.role === 'dispatcher',
      isAdmin: user?.role === 'admin',
    }),
    [user, checking, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
