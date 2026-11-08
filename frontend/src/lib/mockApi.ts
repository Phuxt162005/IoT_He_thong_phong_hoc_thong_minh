import { users } from "../mocks/data";
import type {
  CreateUserInput,
  RegisterInput,
  UpdateUserInput,
  User,
  UserListQuery,
} from "../types";
import { useAuthStore } from "../store/auth";
const wait = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 280));
const passwords = new Map(users.map((user) => [user.id, "Smart@123456"]));
function requireAdmin() {
  if (useAuthStore.getState().user?.role !== "ADMIN")
    throw new Error("Không có quyền quản lý tài khoản.");
}
function addUser(input: RegisterInput, role: User["role"]): User {
  if (users.some((user) => user.username === input.username))
    throw new Error("Tên đăng nhập đã được sử dụng");
  const user: User = {
    id: crypto.randomUUID(),
    username: input.username,
    display_name: input.display_name,
    role,
    status: "ACTIVE",
  };
  users.push(user);
  passwords.set(user.id, input.password);
  return user;
}
export const mockApi = {
  login: async (username: string, password: string) => {
    const user = users.find((x) => x.username === username);
    if (
      !user ||
      user.status !== "ACTIVE" ||
      password !== passwords.get(user.id)
    )
      throw new Error("Tên đăng nhập hoặc mật khẩu không đúng.");
    return wait({ access_token: `mock-token-${user.id}`, user: { ...user } });
  },
  register: (input: RegisterInput) => wait(addUser(input, "VIEWER")),
  me: () => wait(useAuthStore.getState().user!),
  changePassword: async (current: string, next: string) => {
    const id = useAuthStore.getState().user?.id;
    if (!id || passwords.get(id) !== current)
      throw new Error("Mật khẩu hiện tại không đúng.");
    passwords.set(id, next);
    await wait(undefined);
  },
  userPage: (params: UserListQuery) => {
    requireAdmin();
    const filtered = users.filter(
      (user) =>
        (!params.role || user.role === params.role) &&
        (!params.status || user.status === params.status),
    );
    return wait({
      items: filtered.slice(
        (params.page - 1) * params.page_size,
        params.page * params.page_size,
      ),
      total: filtered.length,
    });
  },
  createUser: (input: CreateUserInput) => {
    requireAdmin();
    return wait(addUser(input, input.role));
  },
  updateUser: (id: string, input: UpdateUserInput) => {
    requireAdmin();
    const user = users.find((item) => item.id === id);
    if (!user || user.role === "ADMIN")
      throw new Error("Không thể sửa tài khoản này.");
    Object.assign(user, input);
    return wait({ ...user });
  },
  resetPassword: async (id: string, password: string) => {
    requireAdmin();
    const user = users.find((item) => item.id === id);
    if (!user || user.role === "ADMIN")
      throw new Error("Chỉ đặt lại mật khẩu cho Operator hoặc Viewer.");
    passwords.set(id, password);
    await wait(undefined);
  },
};
export type MockApi = typeof mockApi;
