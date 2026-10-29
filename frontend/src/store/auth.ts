import { create } from 'zustand';
import type { Role, User } from '../types';
type AuthState = { token: string | null; user: User | null; login: (token: string, user: User) => void; logout: () => void; hasRole: (roles: Role[]) => boolean; };
export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('smart_token'), user: JSON.parse(localStorage.getItem('smart_user') || 'null') as User | null,
  login: (token, user) => { localStorage.setItem('smart_token', token); localStorage.setItem('smart_user', JSON.stringify(user)); set({ token, user }); },
  logout: () => { localStorage.removeItem('smart_token'); localStorage.removeItem('smart_user'); set({ token: null, user: null }); },
  hasRole: (roles) => Boolean(get().user && roles.includes(get().user!.role)),
}));
