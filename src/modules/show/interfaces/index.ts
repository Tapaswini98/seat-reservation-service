import { SeatViewDto, ShowResponseDto } from '../dto/show-response.dto';

/** See the note in the reservation module's interfaces: the DTO class owns the shape. */
export type ShowStateView = ShowResponseDto;
export type SeatView = SeatViewDto;
