# 🔍 Code Review Report

## Summary

| Metric | Value |
|--------|-------|
| **Overall Score** | 15/100 |
| **Files Reviewed** | 1 |
| **Critical Issues** | 3 |
| **High Priority Tests** | 6 |
| **Refactoring Opportunities** | 5 |

## 🎯 Top Recommendations

1. 🚨 **security**: src/todo.ts:120 SQL injection vulnerability through direct string interpolation in the searchTodos function. The 'keyword' parameter is directly embedded into the SQL query using template literals, allowing an attacker to inject arbitrary SQL commands. For example, a keyword like "'; DROP TABLE todos; --" would execute destructive commands. Suggested fix: Use parameterized queries with placeholders. Replace with: const query = 'SELECT * FROM todos WHERE title LIKE ? OR description LIKE ?'; const rows = await db.query(query, [`%${keyword}%`, `%${keyword}%`]);
   - Files: src/todo.ts

2. 🚨 **security**: src/todo.ts:131 SQL injection vulnerability through string concatenation in searchTodosByStatus. The 'completed' parameter is concatenated directly into the SQL query without validation or parameterization. An attacker could inject malicious SQL by passing values like "1 OR 1=1" to bypass filters or "1; DROP TABLE todos; --" to execute destructive commands. Suggested fix: Use parameterized queries and validate input type. Replace with: const sql = 'SELECT * FROM todos WHERE completed = ?'; const rows = await db.query(sql, [completed]); Also add validation: if (completed !== 'true' && completed !== 'false' && completed !== '0' && completed !== '1') { throw new Error('Invalid status value'); }
   - Files: src/todo.ts

3. 🚨 **security**: src/todo.ts:143 SQL injection vulnerability in getTodosByUser through template literal interpolation. The 'userId' parameter is directly embedded in the SQL query without sanitization or parameterization. An attacker could inject SQL commands like "' OR '1'='1" to access all todos or "'; DELETE FROM user_todos; --" to modify/delete data. Suggested fix: Use parameterized queries. Replace with: const query = 'SELECT t.* FROM todos t JOIN user_todos ut ON t.id = ut.todo_id WHERE ut.user_id = ?'; const rows = await db.query(query, [userId]);
   - Files: src/todo.ts

4. ⚠️ **bug-risk**: src/todo.ts:130 Type mismatch: searchTodosByStatus accepts a string parameter 'completed' but SQL comparison expects a boolean or numeric value. The function should accept a boolean type instead of a string to prevent type confusion and ensure correct database queries. Suggested fix: Change the function signature to accept boolean: export async function searchTodosByStatus(completed: boolean): Promise<Todo[]> { const sql = 'SELECT * FROM todos WHERE completed = ?'; const rows = await db.query(sql, [completed]); return rows as Todo[]; }
   - Files: src/todo.ts

5. 📝 **bug-risk**: src/todo.ts:122 Missing input validation: searchTodos does not validate that 'keyword' is defined or is a string. If null, undefined, or a non-string value is passed, it could cause unexpected behavior or errors in the SQL query. Suggested fix: Add input validation at the start of the function: if (!keyword || typeof keyword !== 'string') { throw new Error('Keyword must be a non-empty string'); } if (keyword.trim().length === 0) { return []; }
   - Files: src/todo.ts

## 📁 File Details

### 📄 `src/todo.ts`

**Quality Score:** 15/100 | **Coverage:** ~0%

#### Issues (8)
  - Line 120: `critical` SQL injection vulnerability through direct string interpolation in the searchTodos function. The 'keyword' parameter is directly embedded into the SQL query using template literals, allowing an attacker to inject arbitrary SQL commands. For example, a keyword like "'; DROP TABLE todos; --" would execute destructive commands.
  - Line 131: `critical` SQL injection vulnerability through string concatenation in searchTodosByStatus. The 'completed' parameter is concatenated directly into the SQL query without validation or parameterization. An attacker could inject malicious SQL by passing values like "1 OR 1=1" to bypass filters or "1; DROP TABLE todos; --" to execute destructive commands.
  - Line 143: `critical` SQL injection vulnerability in getTodosByUser through template literal interpolation. The 'userId' parameter is directly embedded in the SQL query without sanitization or parameterization. An attacker could inject SQL commands like "' OR '1'='1" to access all todos or "'; DELETE FROM user_todos; --" to modify/delete data.

  *...and 5 more*

#### Test Gaps (12)
  - `searchTodos(keyword: string)` (critical priority)
  - `searchTodosByStatus(completed: string)` (critical priority)

  *...and 10 more*

#### Refactoring Opportunities (5)
  - **extract-function**: All three search functions share the same pattern of executing a query and casting results to Todo[]. This duplication can be reduced by extracting a common helper function.
  - **rename**: The parameter 'completed' is typed as string but represents a boolean value. The name and type should reflect the actual data type for clarity.

  *...and 3 more*

---

*Generated at 2026-11-22T13:31:20.352Z • Duration: 210726ms*
