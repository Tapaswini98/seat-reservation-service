import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ShowResponseDto } from './dto/show-response.dto';
import { ErrorResponseDto } from '../../shared/dtos/error-response.dto';
import { CreateShowDto } from './dto/create-show.dto';
import { ShowStateView } from './interfaces';
import { ShowService } from './show.service';
import { AdminOnly, Public } from '../../shared/decorators/public.decorator';

@ApiTags('Shows')
@Controller('shows')
export class ShowController {
  constructor(private readonly showService: ShowService) {}

  @ApiOperation({
    summary: 'Create a show and its seat map (admin)',
    description:
      'Creates the show and every seat row in one transaction, so a show can ' +
      'never exist with a partial seat map. Authenticate with the ' +
      'X-Admin-Token header or an admin JWT.',
  })
  @ApiSecurity('x-admin-token')
  @ApiResponse({ status: 201, type: ShowResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Show name already taken',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Admin credentials required',
    type: ErrorResponseDto,
  })
  @AdminOnly()
  @Post()
  create(@Body() dto: CreateShowDto): Promise<ShowStateView> {
    return this.showService.create(dto);
  }

  @ApiOperation({
    summary: 'Seat-by-seat state and counts',
    description:
      'Returns per-seat status plus counts. `reconciled` asserts ' +
      'available + held + confirmed == total_seats on every call.',
  })
  @ApiResponse({ status: 200, type: ShowResponseDto })
  @ApiResponse({ status: 404, description: 'Unknown show', type: ErrorResponseDto })
  @Public()
  @Get(':id')
  findState(@Param('id') showId: string): Promise<ShowStateView> {
    return this.showService.findState(showId);
  }
}
