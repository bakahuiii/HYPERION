const riskyInteractionPatterns = [
  /(?:拿捏|操控|控制对方|欲擒故纵|故意冷落|冷处理|制造焦虑|制造嫉妒|让(?:她|他|对方)吃醋|试探底线|施压|逼迫|道德绑架|套路|套话|PUA)/iu,
  /(?:对方|她|他).{0,16}(?:一定|肯定|显然|必然).{0,12}(?:喜欢你|爱你|对你有意思|在意你)/iu,
]

/** Returns a reason when advice is unsafe or overconfident about another person. */
export function interpersonalAdviceRisk(value: unknown) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return 'empty'
  const matched = riskyInteractionPatterns.find((pattern) => pattern.test(text))
  return matched ? 'manipulative_or_overconfident' : undefined
}

export function isHumanCenteredAdvice(value: unknown) {
  return !interpersonalAdviceRisk(value)
}
