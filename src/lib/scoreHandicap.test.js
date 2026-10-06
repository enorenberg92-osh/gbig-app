import { it,expect } from 'vitest'
import { scoreHandicap } from './scoreHandicap'
it('retains the historical handicap on corrections, but uses current handicap for replacing a penalty',()=>{
 expect(scoreHandicap({handicap:8},{entry_type:'played',handicap_used:4})).toBe(4)
 expect(scoreHandicap({handicap:8},{entry_type:'missed_penalty',handicap_used:4})).toBe(8)
 expect(scoreHandicap({handicap:8},null,{sub_handicap:0})).toBe(0)
})
