# 🔍 Code Review Report

## Summary

| Metric | Value |
|--------|-------|
| **Overall Score** | 0/100 |
| **Files Reviewed** | 1 |
| **Critical Issues** | 3 |
| **High Priority Tests** | 5 |
| **Refactoring Opportunities** | 4 |

## 🎯 Top Recommendations

1. 🚨 **security**: src/todo.ts:121 SQL injection vulnerability: user-supplied 'keyword' parameter is directly interpolated into the SQL query using template literals without sanitization or parameterization, allowing an attacker to execute arbitrary SQL commands. Suggested fix: Use parameterized queries with placeholders: `const query = 'SELECT * FROM todos WHERE title LIKE ? OR description LIKE ?'; await db.query(query, [`%${keyword}%`, `%${keyword}%`]);`
   - Files: src/todo.ts

2. 🚨 **security**: src/todo.ts:131 SQL injection vulnerability: user-supplied 'completed' parameter is directly concatenated into the SQL string without validation or parameterization, enabling SQL injection attacks. Suggested fix: Use parameterized queries: `const sql = 'SELECT * FROM todos WHERE completed = ?'; await db.query(sql, [completed]);`
   - Files: src/todo.ts

3. 🚨 **security**: src/todo.ts:143 SQL injection vulnerability: user-supplied 'userId' parameter is directly embedded in the SQL query via template literal without sanitization, allowing arbitrary SQL execution through malicious input. Suggested fix: Use parameterized queries with placeholders: `const query = 'SELECT t.* FROM todos t JOIN user_todos ut ON t.id = ut.todo_id WHERE ut.user_id = ?'; await db.query(query, [userId]);`
   - Files: src/todo.ts

4. ⚠️ **bug-risk**: src/todo.ts:131 Type mismatch: 'completed' parameter is typed as string but should be boolean based on the database schema context. This may cause runtime errors or unexpected query behavior. Suggested fix: Change parameter type to boolean: `export async function searchTodosByStatus(completed: boolean): Promise<Todo[]>` and use parameterized query with the boolean value.
   - Files: src/todo.ts

5. 🚨 **test-coverage**: src/todo.ts searchTodos(keyword: string): Function uses vulnerable SQL string concatenation with user input. The SQL injection vulnerability allows arbitrary SQL execution through the keyword parameter. No tests verify safe input handling, malicious input rejection, or proper query execution. Suggested test: Test searchTodos with: (1) normal keyword 'meeting' expecting matching todos, (2) SQL injection payload like "'; DROP TABLE todos; --" expecting safe handling or error, (3) special characters like % and _ to verify LIKE clause behavior, (4) empty string expecting all or no results, (5) null/undefined input.
   - Files: src/todo.ts

## 📁 File Details

### 📄 `src/todo.ts`

**Quality Score:** 0/100 | **Coverage:** ~0%

#### Issues (4)
  - Line 121: `critical` SQL injection vulnerability: user-supplied 'keyword' parameter is directly interpolated into the SQL query using template literals without sanitization or parameterization, allowing an attacker to execute arbitrary SQL commands.
  - Line 131: `critical` SQL injection vulnerability: user-supplied 'completed' parameter is directly concatenated into the SQL string without validation or parameterization, enabling SQL injection attacks.
  - Line 143: `critical` SQL injection vulnerability: user-supplied 'userId' parameter is directly embedded in the SQL query via template literal without sanitization, allowing arbitrary SQL execution through malicious input.

  *...and 1 more*

#### Test Gaps (9)
  - `searchTodos(keyword: string)` (critical priority)
  - `searchTodos - SQL LIKE wildcards in keyword` (high priority)

  *...and 7 more*

#### Refactoring Opportunities (4)
  - **pattern-improvement**: SQL injection vulnerability due to direct string interpolation. Should use parameterized queries like existing functions in the file.
  - **pattern-improvement**: SQL injection vulnerability through string concatenation. Should use parameterized queries and proper boolean handling.

  *...and 2 more*

---

*Generated at 2026-11-23T04:21:57.977Z • Duration: 142929ms*
