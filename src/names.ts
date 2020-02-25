import * as es from 'estree'

export function traverseProgram(
  node: es.Node,
  cursor_location: es.Position,
  declarations: string[]
) {
  console.log("Now traversing to")
  console.log(node)
  declarations.concat(getVariableNameIfExists(node, declarations))
  if (within_block(node.loc, cursor_location)) {
    const body = getNodeBodyIfExists(node)
    if (body !== null) {
      console.log(body)
      for (const child of body) {
          traverseProgram(child, cursor_location, declarations)
      }
    }
  }

  function within_block(
    node_loc: es.SourceLocation | null | undefined,
    cursor_loc: es.Position,
  ) {
    if (node_loc == null || node_loc == undefined)  {
      return false
    }
    return before(node_loc.start, cursor_loc) && before(cursor_loc, node_loc.end)
  }
  function before(
    first: es.Position,
    second: es.Position
  ) {
    return first.line < second.line || (first.line === second.line && first.column <= second.column)
  }
}

function getNodeBodyIfExists(
  node: any
) {
  switch (node.type) {
    case 'Program':
    case 'BlockStatement':
    case 'WhileStatement':
    case 'ForStatement':
      return node.body
    // case 'ExpressionStatement':
    // case 'IfStatement':
    // case 'ReturnStatement':
    case 'FunctionDeclaration':
    case 'VariableDeclaration':
    // case 'VariableDeclarator':
    // case 'ArrowFunctionExpression':
    // case 'UnaryExpression':
    // case 'BinaryExpression':
    // case 'LogicalExpression':
    // case 'ConditionalExpression':
    // case 'CallExpression':
    // case 'Identifier':
    // case 'Literal':
    // case 'DebuggerStatement':
    // case 'BreakStatement':
    // case 'ContinueStatement':
    // case 'MemberPattern':
    // case 'ArrayExpression':
    // case 'AssignmentExpression':
    // case 'MemberExpression':
    // case 'Property':
    // case 'ObjectExpression':
    // case 'NewExpression':
    default: return []
  }
}

function getVariableNameIfExists(
  node: any,
  declared_variables: string[]
) {
  if (node.type === 'VariableDeclaration') {
    for (const variable of node.declarations) {
      declared_variables += variable.id.name
      console.log("Variables in scope are:" + declared_variables)
    }
  }
  return declared_variables
}
