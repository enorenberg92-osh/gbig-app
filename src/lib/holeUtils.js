export function hasCompleteCoursePars(course) {
  return Boolean(
    course &&
    Number.isInteger(course.num_holes) &&
    Array.isArray(course.hole_pars) &&
    course.hole_pars.length === course.num_holes &&
    course.hole_pars.every(par => Number.isInteger(par) && par >= 3 && par <= 6)
  )
}

/** Safely pair hole scores and pars; mismatched arrays never read past either end. */
export function zipHoleScoresWithPars(holeScores, holePars) {
  if (!Array.isArray(holeScores) || !Array.isArray(holePars)) return []
  const length = Math.min(holeScores.length, holePars.length)
  return Array.from({ length }, (_, index) => ({
    index,
    hole: index + 1,
    score: holeScores[index],
    par: holePars[index],
  }))
}

