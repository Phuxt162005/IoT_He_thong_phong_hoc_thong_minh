const metrics = { temperature: [-10, 60], humidity: [0, 100], lux: [0, 65535] };
const operators = ["GT", "GTE", "LT", "LTE", "EQ", "NE"];

// Chỉ cho phép cây điều kiện có số nút/độ sâu hữu hạn, không thực thi biểu thức JavaScript tùy ý.
export function validCondition(root) {
  let count = 0;
  function visit(node, depth) {
    if (++count > 20 || depth > 4 || !node || typeof node !== "object" || Array.isArray(node)) return false;
    const keys = Object.keys(node);
    if (keys.length === 1 && ["all", "any"].includes(keys[0])) {
      const children = node[keys[0]];
      return Array.isArray(children) && children.length > 0 && children.length <= 10 && children.every((child) => visit(child, depth + 1));
    }
    if (keys.length !== 3 || !keys.every((key) => ["metric", "operator", "value"].includes(key)) || !operators.includes(node.operator)) return false;
    if (node.metric === "occupancy") return ["EQ", "NE"].includes(node.operator) && typeof node.value === "boolean";
    const range = metrics[node.metric];
    return !!range && typeof node.value === "number" && Number.isFinite(node.value) && node.value >= range[0] && node.value <= range[1];
  }
  return visit(root, 0);
}

export function matches(condition, sample) {
  if (condition.all) return condition.all.every((child) => matches(child, sample));
  if (condition.any) return condition.any.some((child) => matches(child, sample));
  const actual = sample[condition.metric];
  // Thiếu dữ liệu không được coi là điều kiện đúng, kể cả phép NE hoặc occupancy từ payload cũ.
  if (actual === null || actual === undefined) return false;
  switch (condition.operator) {
    case "GT": return actual > condition.value;
    case "GTE": return actual >= condition.value;
    case "LT": return actual < condition.value;
    case "LTE": return actual <= condition.value;
    case "EQ": return actual === condition.value;
    case "NE": return actual !== condition.value;
    default: return false;
  }
}
