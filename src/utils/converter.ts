import * as es from 'estree'
import { mockContext } from '../mocks/context'
import { parse } from '../parser'
import { codify } from '../substituter'
import { Context, substituterNodes } from '../types'
import * as builtin from './substituter'

// the value in the parameter is not an ast node, but a underlying javascript value
// return by evaluateBinaryExpression and evaluateUnaryExpression.
export function valueToExpression(value: any, context?: Context): es.Expression {
  const programString = (typeof value === 'string' ? `"` + value + `"` : String(value)) + ';'
  const program = parse(programString, context ? context : mockContext(2))!
  return (program.body[0] as es.ExpressionStatement).expression
}

export function nodeToValue(node: substituterNodes): any {
  return node.type === 'Literal'
    ? node.value
    : builtin.isBuiltinFunction(node)
    ? builtin[(node as es.Identifier).name]
    : // tslint:disable-next-line
      eval(codify(node))
}
