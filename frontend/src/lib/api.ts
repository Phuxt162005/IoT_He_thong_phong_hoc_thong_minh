import axios from "axios";
import type {
  ApiResponse,
  CreateUserInput,
  RegisterInput,
  UpdateUserInput,
  User,
  UserListQuery,
  UserPage,
} from "../types";
import { useAuthStore } from "../store/auth";
import { mockApi } from "./mockApi";
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "/api/v1",
  timeout: 10000,
});
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = "Bearer " + token;
  return config;
});
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error.response?.status === 401 &&
      !["/auth/login", "/auth/register", "/auth/change-password"].includes(
        error.config?.url,
      )
    )
      useAuthStore.getState().logout();
    return Promise.reject(error);
  },
);
export function apiErrorMessage(
  error: unknown,
  fallback = "Không thể thực hiện thao tác. Vui lòng thử lại.",
): string {
  if (axios.isAxiosError(error))
    return (
      error.response?.data?.error?.message ||
      (error.code === "ERR_NETWORK"
        ? "Không kết nối được backend. Vui lòng kiểm tra máy chủ."
        : fallback)
    );
  return error instanceof Error ? error.message : fallback;
}
const mock = import.meta.env.VITE_USE_MOCK === "true";
const normalizeUser = (user: User & { user_id?: string }): User => ({
  ...user,
  id: user.id || user.user_id || "",
});
async function request<T>(
  promise: Promise<{ data: ApiResponse<T> }>,
): Promise<T> {
  return (await promise).data.data;
}
export const apiService = {
  login: async (username: string, password: string) => {
    const session = mock
      ? await mockApi.login(username, password)
      : await request<{ access_token: string; user: User }>(
          api.post("/auth/login", { username, password }),
        );
    return { ...session, user: normalizeUser(session.user) };
  },
  register: (input: RegisterInput) =>
    mock
      ? mockApi.register(input)
      : request<User>(api.post("/auth/register", input)).then(normalizeUser),
  me: () =>
    mock
      ? mockApi.me()
      : request<User>(api.get("/auth/me")).then(normalizeUser),
  logout: () => (mock ? Promise.resolve() : request(api.post("/auth/logout"))),
  changePassword: (current_password: string, new_password: string) =>
    mock
      ? mockApi.changePassword(current_password, new_password)
      : request(
          api.post("/auth/change-password", { current_password, new_password }),
        ),
  userPage: async (params: UserListQuery): Promise<UserPage> => {
    if (mock) return mockApi.userPage(params);
    const response = await api.get<ApiResponse<User[]>>("/users", { params });
    return {
      items: response.data.data.map(normalizeUser),
      total: response.data.meta?.total ?? response.data.data.length,
    };
  },
  createUser: (input: CreateUserInput) =>
    mock
      ? mockApi.createUser(input)
      : request<User>(api.post("/users", input)).then(normalizeUser),
  updateUser: (id: string, input: UpdateUserInput) =>
    mock
      ? mockApi.updateUser(id, input)
      : request<User>(api.patch(`/users/${id}`, input)).then(normalizeUser),
  resetPassword: (id: string, new_password: string) =>
    mock
      ? mockApi.resetPassword(id, new_password)
      : request(api.post(`/users/${id}/reset-password`, { new_password })),
};
export default api;
