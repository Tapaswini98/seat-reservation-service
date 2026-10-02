import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateShowDto } from './dto/create-show.dto';
import { ShowStateView } from './interfaces';
import { ShowService } from './show.service';
import { AdminOnly, Public } from '../../shared/decorators/public.decorator';

@Controller('shows')
export class ShowController {
  constructor(private readonly showService: ShowService) {}

  @AdminOnly()
  @Post()
  create(@Body() dto: CreateShowDto): Promise<ShowStateView> {
    return this.showService.create(dto);
  }

  @Public()
  @Get(':id')
  findState(@Param('id') showId: string): Promise<ShowStateView> {
    return this.showService.findState(showId);
  }
}
