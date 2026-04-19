# Agent guidelines

## Simplicity and design

- Simple code is the best type of code. Make code simple enough that anyone can understand it immediately.
- Design systems so that special cases disappear and invalid states become unrepresentable. Eliminating special cases is the mark of good code.
- Try to keep things in one function unless composable or reusable.

## TypeScript and style

- Type checking is strict — resolve all TypeScript errors.
- Do not use unnecessary destructuring of variables.
- Make use of function guards whenever possible.
- Do not use `else` statements unless necessary.
- Do not use `try` / `catch` if it can be avoided.
- Avoid `try` / `catch` where possible.
- Avoid `else` statements.
- Avoid using the `any` type.
- Avoid `let` statements.
- Prefer single-word variable names where possible.

add reusable scripts in scripts/ that can improve the dev process