import { Injectable } from '@nestjs/common';
import { loadConfig } from '../../config/configuration';
import { ShowRepository } from '../../models/repositories/show.repository';
import { CreateShowDto } from './dto/create-show.dto';
import { ShowStateView } from './interfaces';
import { SeatStatus } from '../../shared/enums/seat.enum';
import { DomainException } from '../../shared/exceptions/domain.exception';
import { isUuid } from '../../shared/helpers/uuid.helper';
import { log } from '../../shared/logger/logger';

@Injectable()
export class ShowService {
  private readonly config = loadConfig();

  constructor(private readonly showRepository: ShowRepository) {}

  async create(dto: CreateShowDto): Promise<ShowStateView> {
    const seatNumbers = [...new Set(dto.seats)];
    if (seatNumbers.length !== dto.seats.length) {
      throw DomainException.validation('seats contains duplicate labels', {
        provided: dto.seats.length,
        distinct: seatNumbers.length,
      });
    }
    if (seatNumbers.length > this.config.domain.maxSeatsPerShow) {
      throw DomainException.validation(
        `a show may have at most ${this.config.domain.maxSeatsPerShow} seats`,
      );
    }

    const showId = await this.showRepository.createWithSeats({
      name: dto.name,
      pricePaise: dto.price_paise,
      perUserLimit: dto.per_user_limit ?? this.config.domain.defaultPerUserLimit,
      seatNumbers,
    });

    log({ show_id: showId, seats: seatNumbers.length }).info('show created');
    return this.findState(showId);
  }

  async findState(showId: string): Promise<ShowStateView> {
    if (!isUuid(showId)) throw DomainException.showNotFound(showId);

    const show = await this.showRepository.findSummaryById(showId);
    if (!show) throw DomainException.showNotFound(showId);

    const seats = await this.showRepository.findSeatStates(showId);

    const counts = {
      available: 0,
      held: 0,
      confirmed: 0,
      total: seats.length,
    };
    for (const seat of seats) counts[seat.status] += 1;

    // The invariant is asserted on the way out, not merely documented. If the
    // three buckets ever fail to sum to the declared total we would rather
    // find out from this endpoint than from a customer holding a duplicate
    // ticket.
    const reconciled =
      counts.available + counts.held + counts.confirmed === show.total_seats;
    if (!reconciled) {
      log({ show_id: showId, counts, total_seats: show.total_seats }).error(
        'RECONCILIATION VIOLATION: seat states do not sum to total_seats',
      );
    }

    return {
      id: show.id,
      name: show.name,
      price_paise: Number(show.price_paise),
      per_user_limit: show.per_user_limit,
      total_seats: show.total_seats,
      counts,
      reconciled,
      seats: seats.map((seat) => ({
        seat_number: seat.seat_number,
        status: seat.status as SeatStatus,
        held_until: seat.held_until ? seat.held_until.toISOString() : null,
      })),
    };
  }
}
