import { Controller, NotImplementedException, Patch } from '@nestjs/common';


@Controller('address')
export class AddressController {

    @Patch('settings')
    async settings() {
        throw new NotImplementedException('Address settings are not implemented');
    }
}
