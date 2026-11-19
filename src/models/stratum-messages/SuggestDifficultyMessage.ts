import { Expose, Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumber, Min } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { eResponseMethod } from '../enums/eResponseMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

const MIN_SUGGESTED_DIFFICULTY = 0.00001;

export class SuggestDifficulty extends StratumBaseMessage {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(1)
    @IsNumber({}, { each: true })
    params: string | number[];



    @Expose()
    @IsNumber()
    @Min(MIN_SUGGESTED_DIFFICULTY)
    @Transform(({ value, key, obj, type }) => {
        return Number(obj.params[0]);
    })
    public suggestedDifficulty: number;

    constructor() {
        super();
        this.method = eRequestMethod.SUGGEST_DIFFICULTY;

    }



    public response(difficulty: number) {
        return {
            id: null,
            method: eResponseMethod.SET_DIFFICULTY,
            params: [difficulty]
        }
    }
}

